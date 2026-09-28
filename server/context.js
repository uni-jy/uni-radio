// 把 6 类碎片拼成 system prompt + 一条 user 消息
// 现在每个 tenant 有自己的 taste / routines / playlists
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function readSafe(p) {
  try { return await fs.readFile(p, "utf8"); } catch { return ""; }
}

function nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const wk = ["周日","周一","周二","周三","周四","周五","周六"][d.getDay()];
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${wk} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {object} opts
 * @param {string} opts.userText
 * @param {string} opts.trigger
 * @param {Array}  opts.recentPlays
 * @param {object} opts.tenant      ← 必传：当前请求所属的 Tenant
 * @returns {Promise<{system:string, user:string}>}
 */
export async function build({ userText = "", trigger = "chat", recentPlays = [], tenant, slot, userHint = null, listeningContext = null } = {}) {
  if (!tenant) throw new Error("context.build 需要 tenant");
  const [persona, taste, routines] = await Promise.all([
    readSafe(path.join(ROOT, "server/prompts/dj-persona.md")),
    readSafe(tenant.tastePath),
    readSafe(tenant.routinesPath),
  ]);

  const env = `## 当前环境\n- 时间：${nowStr()}\n- 触发：${trigger}\n- 听众：${tenant.displayName}`;

  const contextBlock = listeningContext && (listeningContext.mood || listeningContext.scene || listeningContext.energy || listeningContext.avoid?.length)
    ? `## 本次对话形成的听歌上下文\n- 情绪：${listeningContext.mood || "未明确"}\n- 场景：${listeningContext.scene || "未明确"}\n- 能量：${listeningContext.energy || "未明确"}\n- 避免：${listeningContext.avoid?.length ? listeningContext.avoid.join("、") : "无"}\n只把它作为后续几首歌的方向参考；不要为了迎合标签而推荐与听众画像无关的歌。`
    : "";

  const plays = recentPlays.length
    ? "## 最近播放（新→旧）\n" + recentPlays.slice(0, 10).map(p => `- ${p.title} — ${p.artist}`).join("\n")
    : "## 最近播放\n（还没有）";

  // 5 首循环槽位提示 + 听众已知数据
  let rotation = "";
  if (slot != null && typeof slot === "number" && tenant.taasteSignals) {
    const sig = tenant.taasteSignals();
    const slotPos = slot % 5;
    const slotInstructions = [
      "**slot 0/5：用户听过但不算多的歌**——pick 一首他听众侧写里 mid 池 / 自建歌单深处的歌，他听过几次但没「循环 100 遍」的那种",
      "**slot 1/5：用户听过但不算多的歌**——同 slot 0，挑另一个方向",
      "**slot 2/5：用户没听过的歌（探索）**——根据他的口味推测他会喜欢、但播放历史里**从没出现**过的歌；可以跨他的舒适区一点点",
      "**slot 3/5：用户没听过的歌（探索）**——同 slot 2，不同方向",
      "**slot 4/5：用户听得多的歌**——挑他高频复听的一首回归舒适区",
    ];
    rotation = `## 本次推荐在 5 首循环里的位置\n${slotInstructions[slotPos]}\n\n`;
    // userHint 直接限制可选池，避免模型"看到 high pool 就破戒"
    const showHigh = !userHint || userHint === "high";
    const showMid  = !userHint || userHint === "mid";
    if (sig.high.length && showHigh) {
      rotation += `### 他听得多的歌（high pool${userHint === "high" ? "——**必须从这里选一首**" : "，避免在 slot 0-3 推这些"}）\n`;
      rotation += sig.high.slice(0, 10).map(s => `- ${s.title} — ${s.artist}`).join("\n") + "\n\n";
    }
    if (sig.mid.length && showMid) {
      rotation += `### 他听过但不多的歌（mid pool${userHint === "mid" ? "——**必须从这里选一首**" : "，slot 0-1 可以推这里的"}）\n`;
      rotation += sig.mid.slice(0, 15).map(s => `- ${s.title} — ${s.artist}`).join("\n") + "\n\n";
    }
    if (sig.knownArtists.length) {
      const artistHint = userHint === "new"
        ? "**必须从这些歌手的没听过曲目、或风格相邻的新歌手里选**；绝不要重复 high/mid 池里的歌"
        : "slot 2-3 可以用这些歌手没听过的歌，或风格相邻的新歌手";
      rotation += `### 他已知的歌手（${artistHint}）\n`;
      rotation += sig.knownArtists.slice(0, 20).join("、") + "\n\n";
    }
  }

  // 用户显式选了"下一首方向"——硬指令，放在 system 最前面
  let directive = "";
  if (userHint) {
    const map = {
      high: "## ⚠️ 用户硬性要求（必须遵守）\n这次推荐**必须是听众【高频复听】的歌**（high pool 里的）。不要推他听得少或没听过的。",
      mid:  "## ⚠️ 用户硬性要求（必须遵守）\n这次推荐**必须是听众【听过但不算多】的歌**（mid pool 里的）。不要推他高频循环的也不要推完全没听过的。",
      new:  "## ⚠️ 用户硬性要求（必须遵守）\n这次推荐**必须是听众【完全没听过】的歌**：不在 high/mid 池里，不在最近播放列表里。新发现不是猎奇，必须仍然贴近**当前听众自己的** taste.md、已知歌手、歌单语境和近期反馈。可以跨舒适区一点点，但不能跨到和这个听众画像明显无关的分类。\n\n**绝对禁止**推荐：儿歌/儿童/宝宝巴士、DJ土嗨/喊麦/车载串烧、抖音快手神曲、游戏/原神/二创/meme/梗曲、BGM/伴奏/铃声、cover/翻唱、虚拟歌手、remix/slowed/sped up/nightcore。不要因为歌名有“时间”“落泪”这种抽象词就牵强推荐。\n\n请一次给出 6-8 首候选，全部放进 `play[]`。优先选择网易云音乐大概率能搜到、歌名和歌手明确、非 VIP 冷门资源风险低的正式录音。每首都要是不同歌手或不同风格角度，`reason` 里说明它是从这个听众已知口味的哪条线推过去的。",
    };
    directive = map[userHint];
  }

  // 短期重复抑制：最近 8 首避免再推
  const avoidRecent = recentPlays.length
    ? "## 避免重复（这些刚播过，至少 5 首内别再推）\n" +
      recentPlays.slice(0, 8).map(p => `- ${p.title} — ${p.artist}`).join("\n")
    : "";

  const userBlocks = [
    taste && `## 用户品味（taste.md）\n${taste.trim()}`,
    routines && `## 日常节律（routines.md）\n${routines.trim()}`,
  ].filter(Boolean).join("\n\n");

  const system = [directive, persona.trim(), userBlocks, env, contextBlock, plays, avoidRecent, rotation].filter(Boolean).join("\n\n");

  const user = userText
    ? `用户说：${userText}`
    : `（无用户输入，按触发条件 "${trigger}" 主动选曲）`;

  return { system, user };
}
