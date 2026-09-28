// Unico server — 多租户版
// 每个用户用 cookie `unico-uid` 区分；每个用户在 data/users/<uid>/ 有自己的 taste / playlists / 反馈
// server 进程内 Map<uid, Tenant>，所有播放状态、队列、prefetch 都按 tenant 分桶
import "./_env.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { handleChat } from "./router.js";
import { synth } from "./tts.js";
import { resolveOne, lyric as ncmLyric } from "./adapters/ncm.js";
import { askIntro, askIntroStreaming, askTalk, askTalkStreaming, breaker as claudeBreaker } from "./claude.js";
import { getTenant, listTenants, newGuestUid, OWNER_UID } from "./tenant.js";
import { BOOT_MIN_QUEUE, QUEUE_TARGET, buildKnownTrackSet, filterUnheardCandidates } from "./playlist-policy.js";
import { loadPlaybackState, savePlaybackState } from "./playback-state.js";
import { CODE_ROOT, TTS_DIR, USERS_DIR } from "./paths.js";
import { hydrateUserFiles, persistUserFiles } from "./user-storage.js";
import { readTtsFile } from "./tts-storage.js";

const ROOT = CODE_ROOT;
const PWA_DIR = path.join(ROOT, "pwa");
const MEDIA_DIR = path.join(ROOT, "media");
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function synthForTenant(t, text) {
  const result = await synth(text, {
    provider: t?.settings?.ttsProvider,
    voiceId: t?.settings?.fishVoiceId || t?.settings?.voiceId,
    macVoice: t?.settings?.macVoice,
  });
  t?.broadcast?.({ type: "tts-provider", provider: result.provider, cached: !!result.cached });
  return result;
}

function ncmCookieFor(t) {
  return t?.readFile?.(t.cookiePath)?.trim?.() || "";
}

function captureListeningContext(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const rules = [
    {
      rx: /下雨|雨天|雨声|外面.*雨|阴雨|淋雨/,
      hint: "用户刚提到下雨。下一首优先接住雨天、潮湿、窗外、独处的情绪，不要写成天气预报。",
      candidates: [
        { query: "雨天 - 孙燕姿", reason: "你刚说外面在下雨，我就不绕弯了：孙燕姿这首《雨天》正好把那种窗外有雨、心里也有点潮的感觉接住。" },
        { query: "雨 - 甜梅号", reason: "如果想少一点歌词、多一点雨水在屋檐上流动的空间，这首会更贴近。" },
        { query: "下雨天 - 与少年他", reason: "原曲如果因为版权暂时放不了，我会退一步选这首：还是雨天，但更轻，适合把窗外那层湿气留住。" },
      ],
    },
    {
      rx: /做饭|煮饭|下厨|厨房|切菜|炒菜|洗碗/,
      hint: "用户要去做饭/在厨房。下一首可以接住厨房、生活、被日常困住但仍有爱的感觉。",
      candidates: [
        { query: "揪心的玩笑与漫长的白日梦 - 万能青年旅店", reason: "你说要去做饭，我想到这句“是谁来自山川湖海，却囿于昼夜、厨房与爱”。这首不是背景音乐，是很会把宏大理想和灶台边的日常放在一起。" },
      ],
    },
    {
      rx: /通勤|地铁|公交|开车|路上|赶路|回家路上/,
      hint: "用户在路上/通勤。下一首要适合移动中的城市感，不要太炸也不要太睡。",
      candidates: [
        { query: "南方 - 达达乐队", reason: "路上听它很舒服：旋律往前走，但情绪不硬拽，像车窗外的城市慢慢退后。" },
      ],
    },
    {
      rx: /累|疲惫|困|熬夜|不想动|没劲|低电量/,
      hint: "用户疲惫或低电量。下一首要温和、能托住人，不要突然很吵。",
      candidates: [
        { query: "黑暗之光 - 雷光夏", reason: "你现在像是需要一盏不刺眼的灯。这首很轻，但不是空的，适合低电量的时候慢慢回血。" },
      ],
    },
    {
      rx: /烦|焦虑|压力|崩溃|糟心|心乱|不爽/,
      hint: "用户表达压力/烦躁。下一首需要帮他把情绪泄出去或稳定住。",
      candidates: [
        { query: "再见杰克 - 痛仰", reason: "你现在不太适合被温柔劝，倒适合来一点直给的、能把郁气往外推的东西。" },
      ],
    },
  ];
  for (const rule of rules) {
    if (rule.rx.test(raw)) return { hint: rule.hint, candidates: rule.candidates, raw };
  }
  return null;
}

function updateListeningContext(t, text = "") {
  const raw = String(text || "").trim();
  if (!raw || raw.length < 2) return;
  const next = { ...(t.listeningContext || {}), updatedAt: Date.now() };
  if (/通勤|地铁|公交|开车|路上|赶路|出门/.test(raw)) next.scene = "通勤或移动中";
  else if (/工作|上班|写代码|写稿|专注|学习|看书/.test(raw)) next.scene = "专注工作";
  else if (/睡|夜里|深夜|睡前|晚上/.test(raw)) next.scene = "夜间";
  else if (/做饭|厨房|家务|洗碗/.test(raw)) next.scene = "日常家务";
  if (/累|疲惫|困|低电量|没劲|丧/.test(raw)) { next.mood = "疲惫"; next.energy = "low"; }
  if (/烦|焦虑|压力|崩溃|心乱|不爽/.test(raw)) { next.mood = "烦躁"; next.energy = "low"; }
  if (/开心|兴奋|有劲|提神|来点劲/.test(raw)) next.energy = "high";
  if (/安静|别说话|少人声|不要人声|不想被打扰/.test(raw)) next.avoid = [...new Set([...(next.avoid || []), "过多的人声或播报"])];
  if (/吵|太炸|太重|慢一点|放松|舒缓/.test(raw)) next.avoid = [...new Set([...(next.avoid || []), "过高的能量"])];
  if (/新歌|没听过|探索|大胆/.test(raw)) next.explore = true;
  if (/熟悉|喜欢的|老歌|听过/.test(raw)) next.explore = false;
  t.listeningContext = next;
  t.moodHint = `结合本次对话调整后续：${next.scene || "当前场景"}，${next.mood || "当前情绪"}，能量 ${next.energy || "适中"}${next.explore ? "，允许探索新歌" : ""}`;
}

function broadcastGuide(t, kind = "next") {
  if (kind !== "start" && Date.now() - (t.lastGuideAt || 0) < 180_000) return;
  const guides = {
    start: {
      question: "今天想让电台陪你做什么？",
      options: [["通勤路上", "我在通勤路上，后面来点有推进感的"], ["专注工作", "我要专注工作，后面少一点人声"], ["放松一下", "我想放松一下，后面安静一点"], ["想听新歌", "后面给我多安排一点没听过的新歌"]],
    },
    next: {
      question: "下一段想怎么走？",
      options: [["保持现在", "后面保持现在的感觉就好"], ["更有推进感", "后面稍微更有推进感一点"], ["安静一点", "后面安静一点，少一点人声"], ["来点新歌", "后面多安排一点没听过的新歌"]],
    },
  };
  const guide = guides[kind] || guides.next;
  t.lastGuideAt = Date.now();
  t.broadcast({ type: "guide", question: guide.question, options: guide.options.map(([label, text]) => ({ label, text })) });
}

// LRC 解析：返回 [{t: ms, text}]
function parseLRC(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split("\n")) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+)(?:\.(\d+))?\]/g)];
    if (!stamps.length) continue;
    const remainder = line.replace(/\[[^\]]+\]/g, "").trim();
    if (!remainder) continue;
    if (/^(作词|作曲|编曲|制作|出品|策划|演唱|by\b|offical)/i.test(remainder)) continue;
    for (const m of stamps) {
      const mins = +m[1], secs = +m[2];
      const frac = m[3] ? +("0." + m[3]) : 0;
      out.push({ t: Math.round((mins * 60 + secs + frac) * 1000), text: remainder });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

async function broadcastLyricFor(t, track) {
  if (!track?.id) return;
  const myToken = ++t._lyricToken;
  try {
    const text = await ncmLyric(track.id, { cookie: ncmCookieFor(t) });
    if (myToken !== t._lyricToken) return;
    const lines = parseLRC(text);
    t.broadcast({ type: "lyric", trackId: track.id, lines });
    console.log(`[tenant ${t.uid}] lyric ${track.title} — ${lines.length} 行`);
  } catch (e) {
    console.warn(`[tenant ${t.uid}] lyric: ` + e.message);
  }
}

function greetingText() {
  const d = new Date();
  const hour = d.getHours();
  const wk = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  let when, question;
  if (hour < 6)        { when = "凌晨";   question = "怎么这个点还没睡？"; }
  else if (hour < 9)   { when = "早上";   question = "今天有什么打算？"; }
  else if (hour < 12)  { when = "上午";   question = "今天的事顺利吗？"; }
  else if (hour < 14)  { when = "中午";   question = "吃饭了吗？"; }
  else if (hour < 18)  { when = "下午";   question = "下午过得怎么样？"; }
  else if (hour < 22)  { when = "傍晚";   question = "今天忙得怎么样？"; }
  else                 { when = "夜里";   question = "今天还行吗？"; }
  return `Hi，这里是 Unico。周${wk}${when}好，${question}`;
}

const BOOT_LINES = [
  "Unico 在挑今天的第一首歌…",
  "在为你写这首歌的乐评…",
  "调整呼吸，准备问好…",
  "麦克风预热…",
  "马上开始",
];

async function bootWelcome(t) {
  if (!t.welcomePool.length) {
    t.broadcast({ type: "boot-fail", msg: "你还没完成初次设置（请先扫码导入歌单）" });
    return false;
  }

  t.broadcast({ type: "boot-progress", step: 1, total: 4, msg: BOOT_LINES[0] });
  const shuffled = [...t.welcomePool].sort(() => Math.random() - 0.5).slice(0, 5);
  let track = null;
  for (const q of shuffled) {
    track = await resolveOne(q, { cookie: ncmCookieFor(t) });
    if (track) break;
  }
  if (!track) {
    t.broadcast({ type: "boot-fail", msg: "网络好像不给力，再点一次开始？" });
    return false;
  }

  const greeting = greetingText();

  t.broadcast({ type: "boot-progress", step: 2, total: 4, msg: BOOT_LINES[1] });
  const introTextPromise = askIntro({ track, recentPlays: t.recentPlays, userTaste: t.readFile(t.tastePath) }).catch((e) => {
    console.warn(`[tenant ${t.uid}] boot-intro: ` + e.message);
    return "";
  });
  const greetingSynthPromise = synthForTenant(t, greeting).catch((e) => {
    console.warn(`[tenant ${t.uid}] boot-greeting: ` + e.message);
    return null;
  });

  const introText = await introTextPromise;
  t.broadcast({ type: "boot-progress", step: 3, total: 4, msg: BOOT_LINES[2] });
  let introSynth = null;
  if (introText) {
    try { introSynth = await synthForTenant(t, introText); }
    catch (e) { console.warn(`[tenant ${t.uid}] boot-intro-tts: ` + e.message); }
  }
  const greetingSynth = await greetingSynthPromise;

  t.broadcast({ type: "boot-progress", step: 4, total: 4, msg: BOOT_LINES[3] });

  t.nowPlaying = {
    ...track,
    sayUrl: null,
    fullSay: "",
    sayDelayMs: 0,
    segue: "fade",
    exploration: false,
  };
  t.playState.paused = false;
  t.rememberPlayed(t.nowPlaying);
  scheduleTrackEvents(t, track);
  setTimeout(() => prefetchNext(t).catch(() => {}), 3000);

  t.broadcast({
    type: "boot-ready",
    track: t.nowPlaying,
    greetingText: greeting,
    greetingUrl: greetingSynth?.url || null,
    introText: introText || "",
    introUrl: introSynth?.url || null,
  });
  broadcastGuide(t, "start");
  broadcastLyricFor(t, track);
  console.log(`[tenant ${t.uid}] welcome ${track.title} — ${track.artist} (greeting=${!!greetingSynth} intro=${!!introSynth})`);
  if (!introText) backfillIntroIfMissing(t, track).catch(() => {});
  return true;
}

function readPlaylists(t) {
  try { return JSON.parse(t.readFile(t.playlistsJsonPath) || "{}"); }
  catch { return {}; }
}

function broadcastQueue(t) {
  t.broadcast({
    type: "queue",
    target: QUEUE_TARGET,
    loading: !!t.prefetching,
    tracks: t.queue.slice(0, QUEUE_TARGET).map((track) => ({
      title: track.title,
      artist: track.artist,
      picUrl: track.picUrl || "",
      reason: track.reason || track.pickReason || "",
      exploration: true,
    })),
  });
}

function knownTracksFor(t) {
  return buildKnownTrackSet({
    playlists: readPlaylists(t),
    recentPlays: t.recentPlays,
    playedTracks: t.loadPlayedTracks(),
    queuedTracks: [
      ...t.queue,
      ...(t.nowPlaying?.source !== "local" ? [t.nowPlaying] : []),
    ],
    dislikedTracks: t.dislikedTracks,
  });
}

async function bootDiscoveryRadio(t) {
  t.invalidatePrefetch();
  t.clearTrackEvents();
  t.waitingForNext = true;
  t.playState.paused = true;
  t.broadcast({ type: "state", paused: true });
  t.broadcast({ type: "boot-progress", step: 0, total: 5, msg: "正在读取你的听歌偏好…" });
  const completed = await Promise.race([
    prefetchNext(t, { waitForTarget: true, minReady: BOOT_MIN_QUEUE }).then(() => true),
    sleep(90_000).then(() => false),
  ]);
  if (!completed) {
    t.invalidatePrefetch();
    t.waitingForNext = false;
    t.broadcast({ type: "boot-fail", msg: "准备音乐超时了。请检查 Seed API 和网易云连接后重试。" });
    return false;
  }
  if (!t.queue.length) {
    t.waitingForNext = false;
    t.broadcast({ type: "boot-fail", msg: "新歌队列没有生成成功，稍后再试一次" });
    return false;
  }
  t.waitingForNext = false;
  advance(t);
  return true;
}

// 不再预生成 say TTS；prose intro 会在 advance() 后流式推
function buildTrackWithSay(track, r) {
  return {
    ...track,
    sayUrl: null,
    fullSay: "",                        // 由流式 intro 逐句填充
    pickReason: r?.say || r?.reason || "",  // 模型选歌时的简短原因，留作参考
    sayDelayMs: 0,
    segue: r?.segue || "fade",
    exploration: !!r?.exploration,
    degraded: !!r?.degraded,
  };
}

// 把流过来的文本按句切。中英文标点都识别。
function makeSentenceSplitter(onSentence) {
  let buf = "";
  const SENT_RX = /^([\s\S]*?[。！？!?])/; // 不用句号 "." 避免歌名里的英文 "." 误切
  return {
    push(delta) {
      buf += delta;
      while (true) {
        const m = buf.match(SENT_RX);
        if (!m) break;
        const sentence = m[1].trim();
        buf = buf.slice(m[1].length);
        if (sentence) onSentence(sentence);
      }
    },
    flush() {
      const tail = buf.trim();
      buf = "";
      if (tail) onSentence(tail);
    },
  };
}

// 对一段 talk 回复启动流式：边出 LLM 文本边并行 TTS，按句广播
// chunkKind: "intro" | "talk"
function streamChunksFor(t, opts) {
  const { chunkKind, trackId } = opts;
  let chunkIdx = 0;
  let fullText = "";
  const onSentence = (sentence) => {
    if (opts.aborted && opts.aborted()) return;
    const idx = chunkIdx++;
    fullText += (fullText ? " " : "") + sentence;
    t.broadcast({ type: "dj-chunk", idx, trackId, kind: chunkKind, text: sentence, final: false });
    synthForTenant(t, sentence).then(({ url }) => {
      if (opts.aborted && opts.aborted()) return;
      t.broadcast({ type: "dj-chunk-audio", idx, trackId, kind: chunkKind, sayUrl: url });
    }).catch((e) => console.warn(`[stream-${chunkKind}] tts ${idx}: ${e.message}`));
  };
  const splitter = makeSentenceSplitter(onSentence);
  return {
    push: (delta) => splitter.push(delta),
    finalize: () => {
      splitter.flush();
      t.broadcast({ type: "dj-chunk", idx: chunkIdx, trackId, kind: chunkKind, text: "", final: true });
      return fullText;
    },
  };
}

async function streamTalkReply(t, userText) {
  const trackId = "talk-" + Date.now();
  const myToken = ++t._streamToken;
  const aborted = () => myToken !== t._streamToken;
  const pipe = streamChunksFor(t, { chunkKind: "talk", trackId, aborted });
  try {
    await askTalkStreaming({
      user: userText,
      currentTrack: t.nowPlaying,
      recentPlays: t.recentPlays,
      onDelta: (delta) => pipe.push(delta),
    });
    if (aborted()) return;
    pipe.finalize();
  } catch (e) {
    if (aborted()) return;
    console.warn(`[tenant ${t.uid}] stream talk fail: ${e.message}`);
    // 兜底：一次性 askTalk
    try {
      const r = await askTalk({ user: userText, currentTrack: t.nowPlaying, recentPlays: t.recentPlays });
      if (aborted() || !r.say) return;
      const { url } = await synthForTenant(t, r.say).catch(() => ({ url: null }));
      if (aborted()) return;
      t.broadcast({ type: "dj-chunk", idx: 0, trackId, kind: "talk", text: r.say, final: true });
      if (url) t.broadcast({ type: "dj-chunk-audio", idx: 0, trackId, kind: "talk", sayUrl: url });
    } catch (e2) {
      console.warn(`[tenant ${t.uid}] fallback talk: ${e2.message}`);
    }
  }
}

// 对当前 track 启动流式 intro
async function streamIntroForTrack(t, track) {
  if (!track || !track.url) return;
  const myToken = ++t._streamToken;
  const aborted = () => myToken !== t._streamToken || t.nowPlaying?.url !== track.url;
  const trackId = track.id || track.url;
  const pipe = streamChunksFor(t, { chunkKind: "intro", trackId, aborted });
  try {
    await askIntroStreaming({
      track,
      recentPlays: t.recentPlays,
      userTaste: t.readFile(t.tastePath),
      onDelta: (delta) => pipe.push(delta),
    });
    if (aborted()) return;
    const fullSay = pipe.finalize();
    if (t.nowPlaying.url === track.url) t.nowPlaying.fullSay = fullSay;
    console.log(`[tenant ${t.uid}] stream intro done`);
  } catch (e) {
    if (aborted()) return;
    console.warn(`[tenant ${t.uid}] stream intro fail: ${e.message}`);
    try {
      const intro = await askIntro({ track, recentPlays: t.recentPlays, userTaste: t.readFile(t.tastePath) });
      if (aborted()) return;
      const { url } = await synthForTenant(t, intro);
      if (aborted()) return;
      t.broadcast({ type: "dj-chunk", idx: 0, trackId, kind: "intro", text: intro, final: true });
      t.broadcast({ type: "dj-chunk-audio", idx: 0, trackId, kind: "intro", sayUrl: url });
      if (t.nowPlaying.url === track.url) t.nowPlaying.fullSay = intro;
    } catch (e2) {
      console.warn(`[tenant ${t.uid}] fallback intro 也挂了: ${e2.message}`);
    }
  }
}

async function prefetchNext(t, { waitForTarget = false, minReady = QUEUE_TARGET } = {}) {
  // 维护 queue 深度 = 5：切歌时立即 pop，后台补回 5 首新发现
  if (t.prefetching || t.queue.length >= QUEUE_TARGET) return;
  t.prefetching = true;
  broadcastQueue(t);
  const myToken = ++t.prefetchToken;
  const aborted = () => myToken !== t.prefetchToken;
  const trigger = t.moodHint ? `continue:${t.moodHint}` : "continue";
  try {
    for (let attempt = 1; attempt <= 5 && t.queue.length < QUEUE_TARGET; attempt++) {
      if (aborted()) { console.log(`[tenant ${t.uid}] prefetch 作废`); return; }
      if (waitForTarget) {
        t.broadcast({
          type: "boot-progress",
          step: attempt,
          total: 5,
          msg: `正在寻找适合你的音乐（${attempt}/5）…`,
        });
      }
      console.log(`[tenant ${t.uid}] prefetch unheard (${trigger}) attempt ${attempt}/5 queue=${t.queue.length}/${QUEUE_TARGET}`);
      const r = await handleChat("", {
        recentPlays: t.recentPlays, trigger, tenant: t,
        slot: 2,
        userHint: "new",
        intentCandidates: t.intentCandidates || [],
        maxTracks: QUEUE_TARGET * 3,
      });
      if (aborted()) return;
      if (r.ok && r.tracks?.length) {
        if (waitForTarget && r.degraded) {
          t.broadcast({ type: "boot-progress", step: attempt, total: 5, msg: "Seed 暂时连接不上，先用探索歌单开台…" });
        }
        const known = knownTracksFor(t);
        const fresh = filterUnheardCandidates(r.tracks, known);
        // 降级模式下模型不可用，安全池可能全部来自用户已导入歌单。
        // 允许从中取歌先把电台开起来，后续 Seed 恢复后再回到未听过过滤。
        const candidates = fresh.length || !r.degraded
          ? fresh
          : r.tracks.filter((cand) => cand?.title && cand?.artist);
        for (const cand of candidates) {
          if (t.queue.length >= QUEUE_TARGET) break;
          const built = buildTrackWithSay(cand, { ...r, exploration: true });
          if (aborted()) return;
          t.queue.push(built);
          console.log(`[tenant ${t.uid}] unheard ready: ${built.title} (queue=${t.queue.length}/${QUEUE_TARGET})`);
        }
        broadcastQueue(t);
        if (!fresh.length && !r.degraded) {
          console.warn(`[tenant ${t.uid}] batch 里没有未听过的新歌，重新选`);
          await sleep(800);
        }
        if (!waitForTarget && t.waitingForNext && t.queue.length) {
          t.waitingForNext = false;
          advance(t);
          return;
        }
        if (waitForTarget && t.queue.length >= minReady) return;
        continue;
      }
      console.warn(`[tenant ${t.uid}] prefetch attempt ${attempt} fail: ${r.reason}${r.error ? " — " + r.error.slice(0, 100) : ""}`);
      if (attempt < 5) await sleep(2000 * attempt);
    }
    if (t.queue.length < QUEUE_TARGET) {
      console.warn(`[tenant ${t.uid}] 新歌队列未补满：${t.queue.length}/${QUEUE_TARGET}`);
    }
    if (!waitForTarget && t.waitingForNext && t.queue.length) {
      t.waitingForNext = false;
      advance(t);
    } else if (t.waitingForNext && !t.queue.length) {
      setTimeout(() => { if (t.waitingForNext) prefetchNext(t).catch(() => {}); }, 30_000);
    }
  } finally {
    t.prefetching = false;
    broadcastQueue(t);
  }
}

function scheduleTrackEvents(t, track) {
  t.clearTrackEvents();
  const myToken = ++t._eventToken;
  const durMs = track.duration || 0;
  if (durMs < 60_000) return;

  const midsongEnabled = t.settings?.midsong !== false;
  if (midsongEnabled) {
    t._midSongTimer = setTimeout(() => {
      if (myToken !== t._eventToken) return;
      doMidSongComment(t, track).catch(e => console.warn(`[tenant ${t.uid}] mid: ` + e.message));
    }, 75_000);
  }

  const teaseAt = Math.max(60_000, durMs - 25_000);
  t._teaseTimer = setTimeout(() => {
    if (myToken !== t._eventToken) return;
    doEndTease(t, track).catch(e => console.warn(`[tenant ${t.uid}] tease: ` + e.message));
  }, teaseAt);
}

async function backfillIntroIfMissing(t, track) {
  for (let i = 0; i < 5; i++) {
    await sleep(30_000);
    if (t.nowPlaying.url !== track.url) return;
    if (t.nowPlaying.fullSay && t.nowPlaying.fullSay.length > 30) return;
    try {
      const intro = await askIntro({ track, recentPlays: t.recentPlays, userTaste: t.readFile(t.tastePath) });
      if (!intro) continue;
      if (t.nowPlaying.url !== track.url) return;
      const { url } = await synthForTenant(t, intro);
      if (t.nowPlaying.url !== track.url) return;
      t.nowPlaying.fullSay = intro;
      t.broadcast({ type: "dj", say: intro, kind: "intro" });
      t.broadcast({ type: "overlay", sayUrl: url, fullSay: intro });
      console.log(`[tenant ${t.uid}] intro-backfill 成功（第 ${i + 1} 次）`);
      return;
    } catch {}
  }
  console.log(`[tenant ${t.uid}] intro-backfill 5 次失败，放弃这首`);
}

async function doMidSongComment(t, forTrack) {
  if (t.nowPlaying.url !== forTrack.url) return;
  try {
    const r = await askTalk({
      user: "你正在播这首歌，已经播了一分多钟。请只说一两句低风险中段评论：你不能真实听到音频，所以不要假装描述具体乐器、具体段落、歌词、年份、成员、制作人、现场故事、榜单或八卦。可以基于歌名、歌手、当前电台氛围，提醒听众再听一会儿。没有把握就回 say=\"\"。语气像朋友小声补一句，不要播音腔。",
      currentTrack: forTrack,
      recentPlays: t.recentPlays,
    });
    if (!isSafeMidSongComment(r.say)) return;
    if (t.nowPlaying.url !== forTrack.url) return;
    const { url } = await synthForTenant(t, r.say);
    if (t.nowPlaying.url !== forTrack.url) return;
    t.broadcast({ type: "dj", say: r.say, kind: "mid" });
    t.broadcast({ type: "overlay", sayUrl: url, fullSay: r.say });
  } catch (e) { console.warn(`[tenant ${t.uid}] mid: ` + e.message); }
}

function isSafeMidSongComment(s = "") {
  const text = String(s || "").trim();
  if (text.length < 4 || text.length > 90) return false;
  if (/[《「『“"][^》」』”"]{4,}[》」』”"]/.test(text)) return false;
  if (/(19|20)\d{2}|作词|作曲|编曲|制作人|制作|成员|主唱|吉他手|贝斯手|鼓手|发行|专辑销量|榜单|排名|现场|巡演|采样|歌词|这句|副歌|主歌|间奏|solo/i.test(text)) return false;
  return true;
}

async function doEndTease(t, forTrack) {
  if (t.nowPlaying.url !== forTrack.url) return;
  if (!t.queue.length) return;
  const next = t.queue[0];
  const say = `下一首是来自${next.artist}的《${next.title}》。`;
  try {
    const { url } = await synthForTenant(t, say);
    if (t.nowPlaying.url !== forTrack.url) return;
    t.broadcast({ type: "dj", say, kind: "tease" });
    t.broadcast({ type: "overlay", sayUrl: url, fullSay: say });
  } catch (e) { console.warn(`[tenant ${t.uid}] tease: ` + e.message); }
}

async function advance(t) {
  if (t.queue.length) {
    t.nowPlaying = t.queue.shift();
    t.rememberPlayed(t.nowPlaying);
    broadcastQueue(t);
    t.playState.paused = false;
    t.broadcast({ type: "now", track: t.nowPlaying });
    t.broadcast({ type: "state", paused: false });
    broadcastGuide(t, "next");
    broadcastLyricFor(t, t.nowPlaying);
    scheduleTrackEvents(t, t.nowPlaying);
    // 流式 intro：歌开始 ~5s 后开始流式生成 + 边出文字边并行 TTS
    const startTrack = t.nowPlaying;
    setTimeout(() => {
      if (t.nowPlaying?.url === startTrack.url) {
        streamIntroForTrack(t, startTrack).catch(() => {});
      }
    }, 5_000);
    setTimeout(() => prefetchNext(t).catch(() => {}), 500);
    return;
  }
  // 队列空：进入加载态并等待新发现队列生成
  t.waitingForNext = true;
  t.playState.paused = true;
  t.broadcast({ type: "state", paused: true });
  t.broadcast({ type: "queue-empty" });
  prefetchNext(t).catch(() => {});
}

// 熔断器恢复时通知所有租户的所有 client
claudeBreaker.onChange((state) => {
  for (const t of listTenants()) {
    t.broadcast({ type: "claude-state", ...state, remainingMs: claudeBreaker.remaining() });
  }
});

// ========== HTTP helpers ==========
function send(res, code, body, headers = {}) {
  res.writeHead(code, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function readJsonBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function ensureUidCookie(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let uid = cookies["unico-uid"];
  if (!uid) {
    uid = newGuestUid();
    res.setHeader("Set-Cookie",
      `unico-uid=${uid}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`);
  }
  return uid;
}

function streamProxy(req, res, upstream) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  headers["User-Agent"] = "Mozilla/5.0";
  fetch(upstream, { headers }).then((upstreamRes) => {
    const fwd = {
      "Content-Type": upstreamRes.headers.get("content-type") || "audio/mpeg",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    };
    const cl = upstreamRes.headers.get("content-length");
    if (cl) fwd["Content-Length"] = cl;
    const cr = upstreamRes.headers.get("content-range");
    if (cr) fwd["Content-Range"] = cr;
    res.writeHead(upstreamRes.status, fwd);
    let bytes = 0;
    const reader = upstreamRes.body.getReader();
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) return res.end();
      bytes += value.length;
      res.write(value); pump();
    }).catch((e) => {
      console.warn(`[proxy/audio] 上游流断 after ${bytes} bytes: ${e.message}`);
      try { res.end(); } catch {}
    });
    pump();
  }).catch((e) => {
    console.warn("[proxy/audio] " + e.message);
    if (!res.headersSent) send(res, 502, "upstream fail");
  });
}

function serveFile(req, res, absPath) {
  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "Not found");
    const ext = path.extname(absPath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const range = req.headers.range;
    if (range && (ext === ".mp3" || ext === ".m4a" || ext === ".wav")) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      res.writeHead(206, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(absPath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": "no-store" });
    fs.createReadStream(absPath).pipe(res);
  });
}

function serveAudioBuffer(req, res, buffer, type) {
  const size = buffer.length;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (!m || start > end || start >= size) {
      res.writeHead(416, {
        "Cache-Control": "no-store",
        "Content-Range": `bytes */${size}`,
      });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    return res.end(buffer.subarray(start, end + 1));
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  res.end(buffer);
}

async function loadTenant(uid) {
  await hydrateUserFiles(uid);
  return getTenant(uid);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // 宿主认领：访问 /owner 就把 cookie 设成 owner，跳回主页
  if (pathname === "/owner") {
    res.writeHead(302, {
      "Set-Cookie": `unico-uid=${OWNER_UID}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`,
      "Location": "/",
    });
    return res.end();
  }

  if (pathname === "/api/health") {
    return send(res, 200, JSON.stringify({ ok: true, ts: Date.now() }), {
      "Content-Type": "application/json; charset=utf-8",
    });
  }

  // 给每个访问者打 cookie（如果还没有）
  if (pathname === "/" || pathname === "/index.html") {
    ensureUidCookie(req, res);
  }

  // ---- setup API（首次向导） ----
  if (pathname.startsWith("/api/setup/")) {
    const uid = ensureUidCookie(req, res);
    await hydrateUserFiles(uid);
    const m = await import("./setup-api.js");
    return m.handle(req, res, uid, url);
  }

  // ---- 反馈摘要（本人可看） ----
  if (pathname === "/api/me") {
    const uid = ensureUidCookie(req, res);
    const t = await loadTenant(uid);
    return send(res, 200, JSON.stringify({
      uid: t.uid, displayName: t.displayName, hasSetup: t.hasSetup(),
      settings: t.settings, isOwner: uid === OWNER_UID,
    }), { "Content-Type": "application/json; charset=utf-8" });
  }

  // ---- 听众侧写（本人可看） ----
  if (pathname === "/api/me/taste") {
    const uid = ensureUidCookie(req, res);
    const t = await loadTenant(uid);
    const taste = t.readFile(t.tastePath);
    return send(res, 200, JSON.stringify({ taste }),
      { "Content-Type": "application/json; charset=utf-8" });
  }

  if (pathname === "/api/playback-state") {
    const uid = ensureUidCookie(req, res);
    const t = await loadTenant(uid);
    if (req.method === "GET") {
      return send(res, 200, JSON.stringify(loadPlaybackState(t)), {
        "Content-Type": "application/json; charset=utf-8",
      });
    }
    if (req.method === "PUT") {
      return readJsonBody(req)
        .then(async (body) => {
          const state = savePlaybackState(t, body);
          await persistUserFiles(uid);
          return send(res, 200, JSON.stringify(state), {
            "Content-Type": "application/json; charset=utf-8",
          });
        })
        .catch((e) => send(res, 400, JSON.stringify({ error: e.message }), {
          "Content-Type": "application/json; charset=utf-8",
        }));
    }
    return send(res, 405, JSON.stringify({ error: "method not allowed" }), {
      "Content-Type": "application/json; charset=utf-8",
    });
  }

  if (pathname.startsWith("/media/")) {
    const rel = pathname.replace(/^\/media\//, "");
    const abs = path.join(MEDIA_DIR, rel);
    if (!abs.startsWith(MEDIA_DIR)) return send(res, 403, "Forbidden");
    return serveFile(req, res, abs);
  }
  if (pathname.startsWith("/tts/")) {
    const rel = pathname.replace(/^\/tts\//, "");
    const abs = path.join(TTS_DIR, rel);
    if (!abs.startsWith(TTS_DIR)) return send(res, 403, "Forbidden");
    if (fs.existsSync(abs)) return serveFile(req, res, abs);
    const cached = await readTtsFile(rel).catch((e) => {
      console.warn(`[tts/blob] serve ${rel}: ${e.message}`);
      return null;
    });
    if (cached?.buffer) {
      const type = cached.contentType || MIME[path.extname(rel).toLowerCase()] || "application/octet-stream";
      return serveAudioBuffer(req, res, cached.buffer, type);
    }
    return serveFile(req, res, abs);
  }
  if (pathname === "/proxy/audio") {
    const upstream = url.searchParams.get("u");
    if (!upstream) return send(res, 400, "missing u");
    if (!/^https?:\/\/[^\/]*\.music\.126\.net\//i.test(upstream)) {
      return send(res, 403, "domain not allowed");
    }
    return streamProxy(req, res, upstream);
  }

  // PWA 静态
  const rel = pathname === "/" ? "/index.html" : pathname;
  const abs = path.join(PWA_DIR, rel);
  if (!abs.startsWith(PWA_DIR)) return send(res, 403, "Forbidden");
  serveFile(req, res, abs);
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server, path: "/stream" });
let _nextClientId = 0;
wss.on("connection", async (ws, req) => {
  // 从 cookie 取 uid（WS upgrade 请求带的）
  const cookies = parseCookies(req.headers.cookie);
  let uid = cookies["unico-uid"];
  if (!uid) {
    ws.send(JSON.stringify({ type: "fatal", msg: "缺 uid cookie，请刷新页面" }));
    ws.close();
    return;
  }
  const t = await loadTenant(uid);
  const persisted = loadPlaybackState(t);
  if (persisted.currentTrack?.url && t.nowPlaying?.source === "local") {
    t.nowPlaying = persisted.currentTrack;
    t.queue = Array.isArray(persisted.queue) ? persisted.queue : [];
    t.playState.paused = persisted.paused !== false;
  }
  ws._id = ++_nextClientId;
  ws._uid = uid;
  t.clients.add(ws);
  if (!t.activeClient) t.activeClient = ws;

  ws.send(JSON.stringify({ type: "hello", msg: "Unico online", clientId: ws._id, uid, displayName: t.displayName, hasSetup: t.hasSetup() }));
  ws.send(JSON.stringify({ type: "role", active: ws === t.activeClient }));
  ws.send(JSON.stringify({ type: "now", track: t.nowPlaying }));
  ws.send(JSON.stringify({ type: "state", paused: t.playState.paused }));
  broadcastQueue(t);
  if (claudeBreaker.isOpen()) {
    ws.send(JSON.stringify({ type: "claude-state", open: true, remainingMs: claudeBreaker.remaining() }));
  }

  ws.on("close", () => {
    t.clients.delete(ws);
    if (t.activeClient === ws) {
      const next = [...t.clients].find(c => c.readyState === 1);
      t.activeClient = next || null;
      t.notifyRoles();
    }
  });

  ws.on("message", async (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }

    if (m.type === "ping") { ws.send(JSON.stringify({ type: "pong", ts: Date.now() })); return; }
    if (m.type === "claim") { t.setActiveClient(ws); return; }
    if (m.type === "setting") {
      if (m.key === "midsong") {
        t.settings.midsong = !!m.value;
        t.saveSettings();
        scheduleTrackEvents(t, t.nowPlaying);
        ws.send(JSON.stringify({ type: "setting-ack", key: "midsong", value: t.settings.midsong }));
      }
      return;
    }

    if (m.type === "feedback") {
      t.recordFeedback(m.action, t.nowPlaying);
      console.log(`[tenant ${t.uid}] feedback ${m.action}: ${t.nowPlaying.title} — ${t.nowPlaying.artist}`);
      t.broadcast({ type: "feedback-ack", action: m.action, title: t.nowPlaying.title });
      if (m.action === "skip" || m.action === "dislike") {
        t.dislikedTracks.add(`${t.nowPlaying.title}|${t.nowPlaying.artist}`);
        advance(t);
      }
      return;
    }

    if (m.type === "chat") {
      ws.send(JSON.stringify({ type: "chat-ack", text: m.text }));
      try {
        updateListeningContext(t, m.text);
        const listeningContext = captureListeningContext(m.text);
        if (listeningContext) {
          t.moodHint = listeningContext.hint;
          t.intentCandidates = listeningContext.candidates;
          t.invalidatePrefetch();
          broadcastQueue(t);
          prefetchNext(t).catch((e) => console.warn(`[tenant ${t.uid}] contextual prefetch: ${e.message}`));
        }
        const r = await handleChat(m.text, { recentPlays: t.recentPlays, currentTrack: t.nowPlaying, tenant: t });
        if (!r.ok) {
          ws.send(JSON.stringify({ type: "chat-fail", reason: r.reason, query: r.query, error: r.error, misses: r.misses }));
          return;
        }
        if (r.mode === "control") {
          if (r.action === "next") return advance(t);
          if (r.action === "pause") { t.playState.paused = true; t.broadcast({ type: "state", paused: true }); return; }
          if (r.action === "resume") { t.playState.paused = false; t.broadcast({ type: "state", paused: false }); return; }
        }
        if (r.mode === "talk") {
          // 流式：边生成边推 dj-chunk + 并行 TTS
          streamTalkReply(t, r.text || m.text).catch((e) =>
            console.warn(`[tenant ${t.uid}] talk stream: ` + e.message));
          t.invalidatePrefetch();
          broadcastQueue(t);
          prefetchNext(t).catch((e) => console.warn(`[tenant ${t.uid}] dialogue prefetch: ${e.message}`));
          broadcastGuide(t, "next");
          return;
        }
        const built = r.mode === "dj"
          ? await buildTrackWithSay(r.tracks[0], r)
          : { ...r.tracks[0] };
        if (r.mode === "dj") {
          t.broadcast({ type: "dj", say: r.say, reason: r.reason, exploration: r.exploration, misses: r.misses });
        }
        t.moodHint = "";
        t.invalidatePrefetch();
        t.nowPlaying = built;
        t.playState.paused = false;
        t.rememberPlayed(built);
        t.broadcast({ type: "now", track: t.nowPlaying });
        t.broadcast({ type: "state", paused: false });
        broadcastLyricFor(t, built);
        scheduleTrackEvents(t, built);
        setTimeout(() => prefetchNext(t).catch(() => {}), 2000);
      } catch (e) {
        console.error(`[tenant ${t.uid}] chat exception:`, e);
        ws.send(JSON.stringify({ type: "chat-fail", reason: "exception", error: e.message || String(e) }));
      }
      return;
    }

    if (m.type === "control") {
      if (m.action === "play")  { t.playState.paused = false; t.broadcast({ type: "state", paused: false }); return; }
      if (m.action === "pause") { t.playState.paused = true;  t.broadcast({ type: "state", paused: true  }); return; }
      if (m.action === "toggle"){ t.playState.paused = !t.playState.paused; t.broadcast({ type: "state", paused: t.playState.paused }); return; }
      if (m.action === "next")  { return advance(t); }
      if (m.action === "start-radio") {
        if (!t.hasSetup()) {
          t.broadcast({ type: "boot-fail", msg: "请先完成首次设置" });
          return;
        }
        if (t.nowPlaying.source === "local") {
          bootDiscoveryRadio(t).catch(e => {
            console.warn(`[tenant ${t.uid}] discovery boot: ` + e.message);
            t.broadcast({ type: "boot-fail", msg: e.message || "开台失败" });
          });
        } else {
          t.playState.paused = false;
          t.broadcast({ type: "now", track: t.nowPlaying });
          t.broadcast({ type: "state", paused: false });
          broadcastQueue(t);
          prefetchNext(t).catch(() => {});
        }
        return;
      }
      if (m.action === "reset") {
        t.invalidatePrefetch();
        t.clearTrackEvents();
        t.waitingForNext = false;
        t.moodHint = "";
        t.nowPlaying = { title: "Unico 待机", artist: "—", url: "/media/sample.m4a", source: "local" };
        t.playState.paused = true;
        t.broadcast({ type: "now", track: t.nowPlaying });
        t.broadcast({ type: "state", paused: true });
        console.log(`[tenant ${t.uid}] reset`);
        return;
      }
      return;
    }

    if (m.type === "ended") {
      if (ws !== t.activeClient) return;
      advance(t);
      return;
    }

    if (m.type === "track-error") {
      if (ws !== t.activeClient) return;
      console.warn(`[tenant ${t.uid}] track-error code=${m.code} url=${(m.url || "").slice(-60)}`);
      advance(t);
      return;
    }
  });
});

// 预热：owner tenant 启动时就加载好
if (fs.existsSync(path.join(USERS_DIR, OWNER_UID))) {
  getTenant(OWNER_UID);
}

export function startServer(port = PORT) {
  return server.listen(port, () => {
    console.log(`[unico] http://localhost:${port}  ws://localhost:${port}/stream`);
  });
}

export { server };
export default server;

if (process.env.UNICO_AUTOSTART !== "0") {
  startServer(PORT);
}
