const DEFAULT_MODEL = "doubao-seed-2-1-pro-260915";
const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export function getLLMConfig(env = process.env) {
  const provider = String(env.LLM_PROVIDER || "").trim().toLowerCase();
  const seedApiKey = env.SEED_API_KEY || env.VOLCENGINE_API_KEY || env.ARK_API_KEY || "";
  const seedBaseUrl = env.SEED_BASE_URL || env.VOLCENGINE_BASE_URL || env.ARK_BASE_URL || "";
  const deepseekApiKey = env.DEEPSEEK_API_KEY || "";
  const forceDeepSeek = provider === "deepseek";
  const hasSeedConfig = !forceDeepSeek && !!(seedApiKey || seedBaseUrl || env.SEED_MODEL || env.VOLCENGINE_MODEL);
  const hasDeepSeekConfig = !!(deepseekApiKey || env.DEEPSEEK_BASE_URL || env.DEEPSEEK_MODEL);
  if (forceDeepSeek || (!hasSeedConfig && hasDeepSeekConfig)) {
    return {
      apiKey: deepseekApiKey,
      baseUrl: (env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, ""),
      model: env.DEEPSEEK_MODEL || env.UNICO_MODEL || DEFAULT_DEEPSEEK_MODEL,
    };
  }
  const apiKey = seedApiKey || (!hasSeedConfig && (env.OPENAI_API_KEY ||
    env.ANTHROPIC_API_KEY ||
    env.ANTHROPIC_AUTH_TOKEN)) || "";
  const baseUrl = (seedBaseUrl || (!hasSeedConfig && (env.OPENAI_BASE_URL ||
    env.ANTHROPIC_BASE_URL ||
    "")) || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = env.SEED_MODEL || env.VOLCENGINE_MODEL || env.UNICO_MODEL || DEFAULT_MODEL;
  return { apiKey, baseUrl, model };
}

export function buildChatRequest({
  system = "",
  user = "",
  stream = false,
  temperature = 0.8,
  config = getLLMConfig(),
} = {}) {
  if (!config.apiKey) {
    throw new Error("LLM API key 未配置：请设置 SEED_API_KEY 或 DEEPSEEK_API_KEY");
  }
  const body = {
    model: config.model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
    stream,
    temperature,
  };
  // Seed 2.1 Pro 默认开启深度思考。电台选歌和聊天是实时交互，关闭思考可避免
  // 一次推荐请求长时间占用连接；需要完整推理时可在 .env 设置 SEED_THINKING=enabled。
  if (/^doubao-seed/i.test(config.model)) {
    body.thinking = { type: process.env.SEED_THINKING || "disabled" };
    body.max_tokens = 2400;
  }
  return {
    url: `${config.baseUrl}/chat/completions`,
    options: {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  };
}

export function parseChatCompletion(json) {
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("LLM 返回为空");
  }
  return text;
}

export function parseSSEDelta(text) {
  const out = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const evt = JSON.parse(data);
      const delta = evt?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) out.push(delta);
    } catch {}
  }
  return out;
}

export async function completeChat({ system, user, timeoutMs = 180_000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("llm timeout")), timeoutMs);
  try {
    const req = buildChatRequest({ system, user, stream: false });
    const resp = await fetchImpl(req.url, { ...req.options, signal: controller.signal });
    const body = await resp.text();
    if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}: ${body.slice(0, 300)}`);
    return parseChatCompletion(JSON.parse(body));
  } finally {
    clearTimeout(timer);
  }
}

export async function streamChat({
  system,
  user,
  onDelta,
  timeoutMs = 90_000,
  signal,
  fetchImpl = fetch,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("llm stream timeout")), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  try {
    const req = buildChatRequest({ system, user, stream: true });
    const resp = await fetchImpl(req.url, { ...req.options, signal: controller.signal });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`LLM stream HTTP ${resp.status}: ${body.slice(0, 300)}`);
    }
    if (!resp.body) {
      const body = await resp.text();
      const parts = parseSSEDelta(body);
      const full = parts.join("");
      for (const part of parts) onDelta?.(part, full);
      return full;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const boundary = pending.lastIndexOf("\n");
      if (boundary < 0) continue;
      const text = pending.slice(0, boundary + 1);
      pending = pending.slice(boundary + 1);
      for (const delta of parseSSEDelta(text)) {
        full += delta;
        onDelta?.(delta, full);
      }
    }
    for (const delta of parseSSEDelta(pending + decoder.decode())) {
      full += delta;
      onDelta?.(delta, full);
    }
    if (!full.trim()) throw new Error("LLM 流式输出为空");
    return full.trim();
  } finally {
    clearTimeout(timer);
  }
}
