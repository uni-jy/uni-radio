// LLM 适配器：直接调用主模型；不可用时切换到备用通道
// 用法：const out = await ask({ system, user });
//   out = { say, play:[{query,reason}], reason, segue }
import { completeChat, streamChat, getLLMConfig, getDeepSeekConfig } from "./llm-client.js";

const DEFAULT_TIMEOUT_MS = 180_000;
export const MODEL = getLLMConfig().model;
const PRIMARY_CONFIG = getLLMConfig();
const FALLBACK_CONFIG = getDeepSeekConfig();
const CAN_FALLBACK = !!FALLBACK_CONFIG.apiKey &&
  (FALLBACK_CONFIG.baseUrl !== PRIMARY_CONFIG.baseUrl || FALLBACK_CONFIG.model !== PRIMARY_CONFIG.model);

function fallbackLabel() {
  return `${FALLBACK_CONFIG.model} @ ${FALLBACK_CONFIG.baseUrl}`;
}

// —— 熔断器：连续 5 次失败 → 锁死 5 分钟不再调用 LLM
const BREAKER = {
  threshold: 5,            // 连续失败次数
  cooldownMs: 5 * 60_000,  // 锁死时长
  failures: 0,
  openUntil: 0,
  status: "unknown",
  listeners: new Set(),
};
function isBreakerOpen() {
  return Date.now() < BREAKER.openUntil;
}
function remainingMs() {
  return Math.max(0, BREAKER.openUntil - Date.now());
}
function onBreakerChange(fn) { BREAKER.listeners.add(fn); }
function notifyBreaker(state) {
  for (const fn of BREAKER.listeners) { try { fn(state); } catch {} }
}
function noteSuccess() {
  const changed = BREAKER.status !== "connected";
  BREAKER.status = "connected";
  if (BREAKER.failures > 0 || BREAKER.openUntil > Date.now()) {
    BREAKER.failures = 0;
    BREAKER.openUntil = 0;
    notifyBreaker({ open: false, reason: "recovered" });
    console.log("[llm] 服务恢复，熔断器重置");
  } else if (changed) {
    notifyBreaker({ open: false, status: "connected" });
  }
}
function noteFailure(err) {
  BREAKER.failures++;
  BREAKER.status = "unavailable";
  notifyBreaker({ open: false, status: "unavailable" });
  if (BREAKER.failures >= BREAKER.threshold && !isBreakerOpen()) {
    BREAKER.openUntil = Date.now() + BREAKER.cooldownMs;
    notifyBreaker({ open: true, until: BREAKER.openUntil, failures: BREAKER.failures });
    console.warn(`[llm] 连续 ${BREAKER.failures} 次失败，熔断 ${BREAKER.cooldownMs / 60_000} 分钟`);
  }
}
class LLMUnavailable extends Error {
  constructor(remaining) {
    super(`llm unavailable, retry in ${(remaining / 1000).toFixed(0)}s`);
    this.code = "BREAKER_OPEN";
    this.remaining = remaining;
  }
}
export const breaker = { isOpen: isBreakerOpen, remaining: remainingMs, onChange: onBreakerChange,
  status: () => ({ open: isBreakerOpen(), status: BREAKER.status }) };

async function runLLM(prompt, { systemPrompt, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let primaryError = null;
  if (isBreakerOpen()) primaryError = new LLMUnavailable(remainingMs());
  try {
    if (!primaryError) {
      const text = await completeChat({ system: systemPrompt, user: prompt, timeoutMs, config: PRIMARY_CONFIG });
      noteSuccess();
      return text;
    }
  } catch (e) {
    primaryError = e;
    noteFailure(e);
  }
  if (CAN_FALLBACK) {
    try {
      const text = await completeChat({ system: systemPrompt, user: prompt, timeoutMs, config: FALLBACK_CONFIG });
      console.warn(`[llm] Seed unavailable; using DeepSeek fallback (${fallbackLabel()})`);
      noteSuccess();
      return text;
    } catch (fallbackError) {
      console.warn(`[llm] DeepSeek fallback failed: ${fallbackError.message}`);
    }
  }
  throw primaryError;
}

/** 提取首个 JSON 对象（容忍 markdown / 前后白噪音） */
function extractJSON(text) {
  if (!text) return null;
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0 && start >= 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { start = -1; }
    } }
  }
  return null;
}

async function buildIntroPrompt({ track, recentPlays, userTaste }) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const persona = await fs.readFile(path.join(__dirname, "prompts/intro-persona.md"), "utf8");
  const taste = userTaste || (await fs.readFile(path.join(__dirname, "../user/taste.md"), "utf8").catch(() => ""));
  const recent = recentPlays.slice(0, 5).map(p => `- ${p.title} — ${p.artist}`).join("\n");
  const system = persona + "\n\n## 听众侧写\n" + taste.slice(0, 3000);
  const user = `请为这首歌写介绍：
- 歌名：${track.title}
- 歌手：${track.artist}
- 专辑：${track.album || "—"}
${recent ? "\n## 听众最近播放\n" + recent : ""}`;
  return { system, user };
}

/** 给一首"已经在放"的歌写电台介绍 + 乐评。返回 prose 字符串。 */
export async function askIntro({ track, recentPlays = [], userTaste = "" }) {
  const { system, user } = await buildIntroPrompt({ track, recentPlays, userTaste });
  const text = String(await runLLM(user, { systemPrompt: system, timeoutMs: 90_000 })).trim();
  // intro-persona 现在输出 prose；如果还是 JSON 形式，剥一下 say
  const parsed = extractJSON(text);
  if (parsed?.say) return String(parsed.say).trim();
  const cleaned = text.replace(/^```\w*\n?/g, "").replace(/\n?```$/g, "").trim();
  if (cleaned && cleaned.length >= 8) return cleaned;
  throw new Error("intro 输出不可用");
}

/** 流式 LLM 调用通用核心：OpenAI-compatible SSE，逐 token 回调，返回完整 text */
async function runLLMStreaming({ system, user, onDelta, signal, timeoutMs = 90_000 }) {
  let primaryError = null;
  let emitted = false;
  const forwardDelta = (delta, total) => {
    emitted = true;
    onDelta?.(delta, total);
  };
  if (isBreakerOpen()) primaryError = new LLMUnavailable(remainingMs());
  try {
    if (!primaryError) {
      const text = await streamChat({ system, user, onDelta: forwardDelta, signal, timeoutMs, config: PRIMARY_CONFIG });
      noteSuccess();
      const cleaned = text.replace(/^```\w*\n?/g, "").replace(/\n?```$/g, "").trim();
      if (!cleaned || cleaned.length < 2) throw new Error("流式输出为空");
      return cleaned;
    }
  } catch (e) {
    primaryError = e;
    noteFailure(e);
  }
  if (CAN_FALLBACK && !emitted && !signal?.aborted) {
    try {
      const text = await streamChat({ system, user, onDelta, signal, timeoutMs, config: FALLBACK_CONFIG });
      console.warn(`[llm] Seed stream unavailable; using DeepSeek fallback (${fallbackLabel()})`);
      noteSuccess();
      const cleaned = text.replace(/^```\w*\n?/g, "").replace(/\n?```$/g, "").trim();
      if (!cleaned || cleaned.length < 2) throw new Error("流式输出为空");
      return cleaned;
    } catch (fallbackError) {
      console.warn(`[llm] DeepSeek stream fallback failed: ${fallbackError.message}`);
    }
  }
  throw primaryError;
}

/** 流式版 askIntro：每段文本到达就回调 onDelta(deltaText, totalText)。返回完整 prose。 */
export async function askIntroStreaming({ track, recentPlays = [], userTaste = "", onDelta, signal, timeoutMs = 90_000 }) {
  const { system, user } = await buildIntroPrompt({ track, recentPlays, userTaste });
  return runLLMStreaming({ system, user, onDelta, signal, timeoutMs });
}

/** 流式版 talk：听众说一句话 → 流式生成 1-2 句回复 */
export async function askTalkStreaming({ user: userText, currentTrack, recentPlays = [], onDelta, signal, timeoutMs = 60_000 }) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const persona = await fs.readFile(path.join(__dirname, "prompts/talk-persona.md"), "utf8");
  const ctxLines = [];
  if (currentTrack?.title) ctxLines.push(`当前在播：${currentTrack.title} — ${currentTrack.artist || ""}`);
  if (recentPlays.length) ctxLines.push(`最近播放：${recentPlays.slice(0, 5).map(p => p.title).join(" · ")}`);
  const ctx = ctxLines.length ? `## 上下文\n${ctxLines.join("\n")}\n` : "";
  const system = persona + "\n\n" + ctx;
  return runLLMStreaming({ system, user: `听众说：${userText}`, onDelta, signal, timeoutMs });
}

/** 聊天回复模式（一次性，保留以备 fallback）：返回 { say, mood_shift } */
export async function askTalk({ user, currentTrack, recentPlays = [] }) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const persona = await fs.readFile(path.join(__dirname, "prompts/talk-persona.md"), "utf8");
  const ctxLines = [];
  if (currentTrack?.title) ctxLines.push(`当前在播：${currentTrack.title} — ${currentTrack.artist || ""}`);
  if (recentPlays.length) ctxLines.push(`最近播放：${recentPlays.slice(0, 5).map(p => p.title).join(" · ")}`);
  const ctx = ctxLines.length ? `## 上下文\n${ctxLines.join("\n")}\n` : "";
  const system = persona + "\n\n" + ctx;
  const text = String(await runLLM(`听众说：${user}`, { systemPrompt: system, timeoutMs: 60_000 })).trim();
  const parsed = extractJSON(text);
  if (parsed?.say) {
    return {
      say: String(parsed.say).trim(),
      mood_shift: String(parsed.mood_shift || "").trim(),
    };
  }
  // 宽容：模型没按 JSON 格式输出，把整段文本当 say
  const cleaned = text.replace(/^```\w*\n?/g, "").replace(/\n?```$/g, "").trim();
  if (cleaned && cleaned.length >= 4) {
    console.warn("[askTalk] 非 JSON 输出，按裸文本使用");
    return { say: cleaned, mood_shift: "" };
  }
  throw new Error("talk 输出不可用");
}

/** 自由文本模式：返回模型原文（markdown 等），不做 JSON 解析 */
export async function askRaw({ system, user, timeoutMs }) {
  return String(await runLLM(user, { systemPrompt: system, timeoutMs }));
}

export async function ask({ system, user, timeoutMs = 60_000 }) {
  const modelText = String(await runLLM(user, { systemPrompt: system, timeoutMs }));
  const parsed = extractJSON(modelText);
  if (!parsed) throw new Error("模型输出不是合法 JSON：" + modelText.slice(0, 400));
  // 字段规范化
  return {
    say: String(parsed.say || "").trim(),
    play: Array.isArray(parsed.play) ? parsed.play.filter(x => x && x.query) : [],
    reason: String(parsed.reason || ""),
    segue: ["fade","hard","talk-over-intro"].includes(parsed.segue) ? parsed.segue : "fade",
    exploration: !!parsed.exploration,
    _raw: modelText,
  };
}
