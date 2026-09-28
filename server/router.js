// 意图分流（v3）
//   1) 控制（next/pause/resume）—— 立即指令，不动 Seed
//   2) 直连（"歌名 - 歌手" 或 "放 X / 来一首 X / 想听 X" 且 X 看起来是具体名字）—— ncm 搜
//   3) 模糊换歌（"换一首"/"换首"/"切歌"/"我想听点 X" 不指定具体歌）—— Seed DJ 模式选新歌
//   4) 默认 —— talk 模式：Seed 短回复，不换歌
import { resolveOne } from "./adapters/ncm.js";
import { build as buildCtx } from "./context.js";
import { ask as askClaude } from "./claude.js";
import { isLowQualityRecommendation } from "./playlist-policy.js";

const COMMAND_RX = {
  next: /^\s*(下一首|下个|跳过|换一首|换首|换歌|切歌|换|skip|next)\s*[!！.。?？]*\s*$/i,
  pause: /^\s*(暂停|停|pause)\s*[!！.。?？]*\s*$/i,
  resume: /^\s*(继续|播放|resume|play)\s*[!！.。?？]*\s*$/i,
};

const SONG_DASH = /^[^-—–]+\s*[-—–]\s*[^-—–]+$/;
const PLAY_PREFIX = /^\s*(放|播放|播|来一首|想听|我想听|来首|给我放|帮我放)\s*[:：]?\s*(.+?)\s*$/;
// 在前缀后面如果出现这些"模糊词"，就不是要具体某首歌，而是表达方向
const FUZZY_WORDS = /点|些|什么|啥|适合|想|帮|心情|感觉|放松|提神|安静|热闹|带感|睡|累|无聊|开心|难过|烦|气|爽|怀旧|怀念|文艺/;
// 强制走 Seed DJ 选新歌：模糊换歌意图
const DJ_SWITCH_HINTS = /换个方向|换换|换种|挑一首|推一首|来点别的|来点其他|不爱这首|这首换|不喜欢这首/;
const RESOLVE_CONCURRENCY = 6;
const SAFE_DISCOVERY = [
  ["中南海 - Carsick Cars", "这首不用解释太满，鼓和吉他一出来就是那种粗粝的现场空气，适合把电台从安全区往外推一点。"],
  ["历史 - 海朋森", "想给你一点更冷的后朋克线条，不是为了装深，是这首的紧绷感很耐听。"],
  ["这辆红色的列车 - P.K.14", "如果你喜欢城市感强、话不说透的乐队歌，这首很适合接上来，像一截不太平稳的夜车。"],
  ["夜长梦多 - 刺猬", "这首比刚硬的摇滚更亮一点，但边缘还在，适合把气氛稍微抬起来。"],
  ["白日梦蓝 - 刺猬", "它有青春感，但不是甜的那种；更像一阵风把房间里的灰吹起来。"],
  ["雨 - 甜梅号", "这首适合不想被歌词打扰的时候听，吉他像雨线一样慢慢铺开。"],
  ["再见杰克 - 痛仰", "需要一点直给的劲儿时，这首很管用，不绕，往前走。"],
  ["南方 - 达达乐队", "旋律很顺，但情绪不轻浮；适合把电台从阴影里带到有风的地方。"],
  ["黑暗之光 - 雷光夏", "想让夜色安静下来时我会想到它，轻，但不是空。"],
  ["没有理想的人不伤心 - 新裤子", "这首的失落感很城市，也很直接，不需要太多铺垫。"],
  ["低处穿巡 - 腰乐队", "这首适合给喜欢粗粝、克制、低温表达的人，话少，但骨头很硬。"],
  ["海鸥舞曲 - 声子虫", "如果想把人声撤掉一会儿，这首能让空间自己说话。"],
];

function tenantCookie(tenant) {
  return tenant?.readFile?.(tenant.cookiePath)?.trim?.() || "";
}

async function resolveRecommendation(query, tenant) {
  return await resolveOne(query, { strict: true, cookie: tenantCookie(tenant) }).catch(() => null);
}

function shouldUseIndieFallback(tenant) {
  if (!tenant) return false;
  if (tenant.uid === "owner") return true;
  const sig = tenant.taasteSignals?.() || {};
  const haystack = [
    tenant.readFile?.(tenant.tastePath) || "",
    ...(sig.knownArtists || []),
    ...(sig.playlistNames || []),
  ].join(" ");
  return /万能青年旅店|草东|木马|腰乐队|海朋森|声音碎片|PK14|P\.K\.14|Carsick Cars|后摇|独立摇滚|livehouse/i.test(haystack);
}

export async function handleChat(text, ctx = {}) {
  const raw = (text || "").trim();

  // —— 控制
  if (raw) {
    for (const [action, rx] of Object.entries(COMMAND_RX)) {
      if (rx.test(raw)) return { ok: true, mode: "control", action };
    }
  }

  // —— 直连 / 模糊换歌
  if (raw) {
    if (SONG_DASH.test(raw)) {
      const t = await resolveOne(raw, { cookie: tenantCookie(ctx.tenant) });
      if (!t) return { ok: false, reason: "not_found", query: raw };
      return { ok: true, mode: "direct", tracks: [t] };
    }
    const m = PLAY_PREFIX.exec(raw);
    if (m) {
      const tail = (m[2] || "").trim();
      if (tail && !FUZZY_WORDS.test(tail)) {
        // 明确歌名 → 直连
        const t = await resolveOne(tail, { cookie: tenantCookie(ctx.tenant) });
        if (!t) return { ok: false, reason: "not_found", query: tail };
        return { ok: true, mode: "direct", tracks: [t] };
      }
      // 走 DJ 模式
      return runDJ(raw, ctx);
    }
    if (DJ_SWITCH_HINTS.test(raw)) {
      return runDJ(raw, ctx);
    }
  }

  // —— 无输入（自动续播 / 空 prefetch）
  if (!raw) return runDJ("", ctx);

  // —— 其它一切 → talk
  return runTalk(raw, ctx);
}

async function runDJ(raw, ctx) {
  const intentCandidates = Array.isArray(ctx.intentCandidates) ? ctx.intentCandidates : [];
  const { system, user } = await buildCtx({
    userText: raw,
    trigger: ctx.trigger || (raw ? "chat" : "continue"),
    recentPlays: ctx.recentPlays || [],
    tenant: ctx.tenant,
    slot: ctx.slot,
    userHint: ctx.userHint,
    listeningContext: ctx.listeningContext || ctx.tenant?.listeningContext,
  });
  let out;
  let degraded = false;
  try { out = await askClaude({ system, user }); }
  catch (e) {
    // Seed 暂时不可用时，自动续播仍然要能开台。优先使用上下文候选，
    // 没有候选时使用安全探索池，避免用户被卡在黑色加载遮罩里。
    const fallback = intentCandidates.length
      ? intentCandidates
      : SAFE_DISCOVERY.map(([query, reason]) => ({ query, reason }));
    if (!fallback.length) return { ok: false, reason: "claude_failed", error: e.message };
    degraded = true;
    console.warn(`[router] Seed unavailable, using ${fallback.length} fallback candidates: ${e.message}`);
    out = {
      play: fallback,
      say: intentCandidates[0]?.reason || "Seed 暂时连接不上，我先为你放一首探索歌。",
      reason: intentCandidates[0]?.reason || "Seed 暂时连接不上，先用探索歌单继续播放。",
      segue: "fade",
      exploration: true,
    };
  }
  const misses = [];
  const tracks = [];
  const maxTracks = Math.max(1, ctx.maxTracks || 1);
  const modelCandidates = Array.isArray(out.play) ? out.play : [];
  const fallbackCandidates = !degraded && ctx.userHint === "new" && shouldUseIndieFallback(ctx.tenant)
    ? SAFE_DISCOVERY.map(([query, reason]) => ({ query, reason }))
    : [];
  const candidates = [...intentCandidates, ...modelCandidates, ...fallbackCandidates];
  const pending = candidates
    .filter((item) => item?.query && !isLowQualityRecommendation({
      title: item.query,
      artist: "",
      reason: item.reason || out.reason || "",
    }))
    .map((item, index) => ({ item, index }));

  let next = 0;
  let active = 0;
  let done = false;
  await new Promise((resolve) => {
    const maybeDone = () => {
      if (done) return;
      if (tracks.length >= maxTracks || (next >= pending.length && active === 0)) {
        done = true;
        resolve();
      }
    };

    async function worker() {
      while (!done && next < pending.length && tracks.length < maxTracks) {
        const { item } = pending[next++];
        active++;
        try {
          const t = await resolveRecommendation(item.query, ctx.tenant);
          if (!t) {
            misses.push(item.query);
            continue;
          }
          if (isLowQualityRecommendation({ ...t, reason: item.reason || out.reason || "" })) {
            misses.push(item.query);
            continue;
          }
          if (tracks.length < maxTracks) tracks.push({ ...t, reason: item.reason || out.reason });
        } finally {
          active--;
          maybeDone();
        }
      }
      maybeDone();
    }

    const workers = Math.min(RESOLVE_CONCURRENCY, pending.length);
    if (!workers) return maybeDone();
    for (let i = 0; i < workers; i++) worker().catch(() => maybeDone());
  });
  if (!tracks.length) return { ok: false, reason: "no_resolvable_song", misses, say: out.say };
  return {
    ok: true, mode: "dj",
    say: out.say, segue: out.segue, reason: out.reason,
    exploration: !!out.exploration, tracks, misses,
    degraded,
  };
}

// talk 模式不在这里发 LLM ——返回意图标记，由调用方决定走流式还是一次性
async function runTalk(raw, ctx) {
  return { ok: true, mode: "talk", text: raw };
}
