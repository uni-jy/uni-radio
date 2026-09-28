// 首次设置向导后端：扫码登录 NCM → 拉歌单 → Seed 写 taste 草稿 → 用户审 → 保存
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getTenant } from "./tenant.js";
import { askRaw } from "./claude.js";
import { DATA_DIR } from "./paths.js";
import { persistUserFiles } from "./user-storage.js";

const require = createRequire(import.meta.url);
const ncm = require("NeteaseCloudMusicApi");
const QRCode = require("qrcode");

function loadQrDeviceId() {
  const devicePath = path.join(DATA_DIR, "ncm-qr-device-id.txt");
  try {
    const existing = fsSync.readFileSync(devicePath, "utf8").trim();
    if (/^[A-F0-9]{52}$/.test(existing)) return existing;
  } catch {}
  const hex = "0123456789ABCDEF";
  let next = "";
  for (let i = 0; i < 52; i++) next += hex[Math.floor(Math.random() * hex.length)];
  fsSync.mkdirSync(path.dirname(devicePath), { recursive: true });
  fsSync.writeFileSync(devicePath, next, "utf8");
  return next;
}

const QR_DEVICE_ID = loadQrDeviceId();
// QR 会话池：本地内存，5 分钟过期
const sessions = new Map();
// Draft 任务池：按 uid 索引，避免在隧道上把长请求拖死
const draftJobs = new Map();  // uid -> { status: 'pending'|'done'|'error', result, error, startedAt }
const LOGIN_DEVICE_HINT = {
  os: "iphone",
  appver: "9.0.90",
  osver: "16.2",
  channel: "App Store",
  mobilename: "iPhone",
  resolution: "1170x2532",
  deviceId: QR_DEVICE_ID,
  sDeviceId: QR_DEVICE_ID,
};

function buildNcmQrUrl(unikey) {
  const chainId = `v1_${QR_DEVICE_ID}_web_login_${Date.now()}`;
  return `https://music.163.com/login?codekey=${encodeURIComponent(unikey)}&chainId=${encodeURIComponent(chainId)}`;
}

function publicSessionDebug(session) {
  if (!session) return null;
  return {
    status: session.status,
    code: session.code || null,
    polls: session.polls || 0,
    lastError: session.lastError || "",
    ageSec: Math.round((Date.now() - session.createdAt) / 1000),
    hasCookie: !!session.cookie,
    hasProfile: !!session.profile,
    chainId: (session.qrurl.match(/chainId=([^&]+)/) || [])[1] || "",
  };
}
function newKey() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
}
function cleanupSessions() {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.createdAt > 5 * 60_000) sessions.delete(k);
  }
}
setInterval(cleanupSessions, 60_000).unref?.();

// ncm 偶发 502 ECONNRESET，统一包一层重试 + 规范化错误
async function ncmCall(fn, ...args) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try { return await fn(...args); }
    catch (e) {
      lastErr = e;
      const status = e?.status || e?.body?.code;
      const code = e?.code || e?.cause?.code;
      if (status !== 502 && code !== "ECONNRESET" && !/ECONNRESET|timeout|fetch failed|result is not defined/i.test(String(e?.body?.msg || e?.message || ""))) {
        // 非瞬时错误直接抛
        const m = e?.body?.msg || e?.message || JSON.stringify(e).slice(0, 200);
        throw new Error(typeof m === "string" ? m : String(m));
      }
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  const m = lastErr?.body?.msg || lastErr?.message || JSON.stringify(lastErr).slice(0, 200);
  throw new Error("ncm 持续 502 / 网络抖动：" + (typeof m === "string" ? m : String(m)));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => buf += c);
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function normalizeNcmCookie(input = "") {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^MUSIC_U=/i.test(raw) || /;\s*MUSIC_U=/i.test(raw)) return raw;
  if (/^[A-Za-z0-9_+\-/=.]{20,}$/.test(raw)) return `MUSIC_U=${raw}`;
  return raw;
}

function normalizePhone(input = "") {
  return String(input || "").replace(/[^\d]/g, "");
}

function normalizeCountryCode(input = "") {
  return String(input || "86").replace(/[^\d]/g, "") || "86";
}

function normalizeNcmUserId(input = "") {
  const raw = String(input || "").trim();
  const idMatch = raw.match(/[?&]id=(\d{5,})/) || raw.match(/\b(\d{5,})\b/);
  return idMatch ? Number(idMatch[1]) : 0;
}

async function saveVerifiedCookie(t, uid, cookie, source = "login") {
  const status = await ncmCall(ncm.login_status, { cookie });
  const profile = status.body?.data?.profile;
  if (!profile?.userId) throw new Error("登录成功但没有读到网易云用户信息");
  await fs.writeFile(t.cookiePath, cookie, "utf8");
  if (profile.nickname) {
    t.displayName = profile.nickname;
    t.settings.nickname = profile.nickname;
    t.saveSettings();
  }
  await persistUserFiles(uid);
  console.log(`[setup ${uid}] ${source} ok: ${profile.nickname} (${profile.userId})`);
  return profile;
}

const TASTE_DRAFT_SYSTEM = `你是一个细心的、不油腻的"听众侧写师"。

**⚠️ 输出格式（最严格的规则，请逐字遵守）**

你的整段回复就是 markdown 文档本身。你**没有**任何工具（不能写文件、不能调命令、不能"等待权限"）。

**你的回复必须以这一行作为开头**（一字不差，不要在它之前放任何文字）：

\`\`\`
# 你的听觉肖像
\`\`\`

之后另起一行直接进入正文段落。

❌ **绝对禁止**以下任何一种开头（这些都是错误示例）：

- "好的，我已经为你写好了..."
- "文件已起草完成..."
- "需要你同意写入权限..."
- "请在权限提示中确认..."
- "已为你保存到 /Users/..."
- 任何 \`\`\`md 或 \`\`\` 标记
- 任何 "我"、"已"、"请" 开头的元叙述

❌ **绝对禁止**在最后一段之后再加任何收尾话术（如"以上就是侧写"、"希望你满意"等）。文档结束你就停止输出。

---

我会给你一份用户在网易云的精简数据快照（自建歌单、最近周榜、全部时间总榜）。

写一份听众侧写：

- 第二人称（"你"），像在跟用户本人聊"我看到你是这样听歌的"
- 自然语言段落，不要 JSON 不要清单（少量举歌手名 OK）
- 必须覆盖：偏好风格 / 年代 / 语种、本命歌手（最多 5-8 个）、不同时段或心境的音乐对应、明显禁区（如果能推断）
- **诚实**：看不出来的别瞎编。数据没体现的就别写
- 每个判断附"我是怎么看出来的"——引用具体歌单名 / 歌手 / 频次
- 长度 800-1500 字
- 结尾留 \`## 待你补充\` 一段，列 3-5 个需要用户亲口说的问题`;

function buildCompactDump(data) {
  const lines = [];
  lines.push(`# 网易云数据精简快照\n`);
  lines.push(`## 最近 7 天 top（${data.week?.length || 0} 首，已按 playCount 倒排）`);
  for (const t of data.week || []) {
    lines.push(`- ${t.title} — ${t.artist}  ×${t.playCount}`);
  }
  lines.push(`\n## 全部时间 top 40`);
  for (const t of (data.allTime || []).slice(0, 40)) {
    lines.push(`- ${t.title} — ${t.artist}`);
  }
  lines.push(`\n## 自建歌单（${data.created?.length || 0}）—— 每单仅列 top 5`);
  for (const p of data.created || []) {
    lines.push(`\n### ${p.name}（${p.trackCount} 首）${p.tags?.length ? " · tag: " + p.tags.join("/") : ""}`);
    if (p.description) lines.push(`> ${p.description.replace(/\n/g, " ").slice(0, 200)}`);
    for (const t of (p.topTracks || []).slice(0, 5)) {
      lines.push(`- ${t.title} — ${t.artist}`);
    }
  }
  lines.push(`\n## 收藏歌单（${data.subscribed?.length || 0}）—— 只列名字`);
  for (const p of (data.subscribed || []).slice(0, 40)) {
    lines.push(`- ${p.name}${p.tags?.length ? " · " + p.tags.join("/") : ""}`);
  }
  return lines.join("\n");
}

async function fetchUserDump(uid, cookie) {
  console.log(`[setup ${uid}] 拉歌单列表`);
  const playlistsResp = await ncmCall(ncm.user_playlist, { uid, limit: 100, cookie });
  const all = playlistsResp.body.playlist || [];
  const created = all.filter((p) => p.creator?.userId === uid);
  const subscribed = all.filter((p) => p.creator?.userId !== uid);

  let week = [], allTime = [];
  try { week = (await ncmCall(ncm.user_record, { uid, type: 1, cookie })).body.weekData || []; } catch {}
  try { allTime = (await ncmCall(ncm.user_record, { uid, type: 0, cookie })).body.allData || []; } catch {}

  const playlists = [];
  for (const p of created) {
    try {
      const detail = await ncmCall(ncm.playlist_detail, { id: p.id, cookie });
      const allIds = (detail.body.playlist?.trackIds || []).slice(0, 20).map(t => t.id);
      const tracks = (detail.body.playlist?.tracks || []).filter(t => allIds.includes(t.id));
      playlists.push({
        id: p.id, name: p.name, description: p.description || "",
        trackCount: p.trackCount, playCount: p.playCount, tags: p.tags || [],
        topTracks: tracks.map(t => ({
          id: t.id, title: t.name,
          artist: (t.ar || []).map(a => a.name).join(" / "),
          album: t.al?.name || "",
        })),
      });
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  const subs = subscribed.map(p => ({
    id: p.id, name: p.name, tags: p.tags || [], trackCount: p.trackCount,
    creator: p.creator?.nickname || "",
  }));
  return {
    fetchedAt: new Date().toISOString(),
    week: week.map(w => ({
      title: w.song.name,
      artist: (w.song.ar || []).map(a => a.name).join(" / "),
      playCount: w.playCount, score: w.score,
    })),
    allTime: allTime.map(w => ({
      title: w.song.name,
      artist: (w.song.ar || []).map(a => a.name).join(" / "),
      playCount: w.playCount, score: w.score,
    })),
    created: playlists,
    subscribed: subs,
  };
}

async function fetchPublicUserDump(ncmUid) {
  console.log(`[setup public] 拉公开歌单列表 uid=${ncmUid}`);
  const playlistsResp = await ncmCall(ncm.user_playlist, { uid: ncmUid, limit: 100 });
  const all = playlistsResp.body.playlist || [];
  const created = all.filter((p) => p.creator?.userId === ncmUid);
  const subscribed = all.filter((p) => p.creator?.userId !== ncmUid);
  const playlists = [];

  for (const p of created) {
    try {
      const detail = await ncmCall(ncm.playlist_detail, { id: p.id });
      const playlist = detail.body.playlist || {};
      const tracks = playlist.tracks || [];
      playlists.push({
        id: p.id,
        name: p.name,
        description: p.description || "",
        trackCount: p.trackCount,
        playCount: p.playCount,
        tags: p.tags || [],
        topTracks: tracks.slice(0, 12).map(t => ({
          id: t.id,
          title: t.name,
          artist: (t.ar || []).map(a => a.name).join(" / "),
          album: t.al?.name || "",
        })),
      });
    } catch (e) {
      console.warn(`[setup public] playlist ${p.id}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  const ownerProfile = created[0]?.creator || all[0]?.creator || {};
  return {
    fetchedAt: new Date().toISOString(),
    source: "public-user-playlists",
    profile: {
      userId: ncmUid,
      nickname: ownerProfile.nickname || "",
    },
    week: [],
    allTime: [],
    created: playlists,
    subscribed: subscribed.map(p => ({
      id: p.id,
      name: p.name,
      tags: p.tags || [],
      trackCount: p.trackCount,
      creator: p.creator?.nickname || "",
    })),
  };
}

export async function handle(req, res, uid, url) {
  const t = getTenant(uid);
  const p = url.pathname;

  try {
    // —— 状态查询
    if (p === "/api/setup/status" && req.method === "GET") {
      return json(res, 200, {
        hasSetup: t.hasSetup(),
        hasTaste: !!t.readFile(t.tastePath),
        hasPlaylists: !!t.readFile(t.playlistsJsonPath),
      });
    }

    // —— 开始扫码登录
    if (p === "/api/setup/qr-start" && req.method === "POST") {
      const keyResp = await ncmCall(ncm.login_qr_key, {});
      const unikey = keyResp.body.data.unikey;
      const qrurl = buildNcmQrUrl(unikey);
      const qrimg = await QRCode.toDataURL(qrurl, { margin: 1, width: 260 });
      const session = { unikey, qrurl, qrimg, createdAt: Date.now(), status: "waiting", polls: 0, code: 801, lastError: "" };
      const sid = newKey();
      sessions.set(sid, session);
      return json(res, 200, { sid, qrurl: session.qrurl, qrimg: session.qrimg, debug: publicSessionDebug(session) });
    }

    if (p === "/api/setup/qr-debug" && req.method === "GET") {
      const sid = url.searchParams.get("sid");
      return json(res, 200, { sid, session: publicSessionDebug(sessions.get(sid)) });
    }

    // —— 轮询扫码状态
    if (p === "/api/setup/qr-check" && req.method === "GET") {
      const sid = url.searchParams.get("sid");
      const session = sessions.get(sid);
      if (!session) return json(res, 404, { error: "session expired" });
      let r;
      session.polls = (session.polls || 0) + 1;
      try { r = await ncmCall(ncm.login_qr_check, { key: session.unikey }); }
      catch (e) {
        // 极端情况下 qr-check 持续失败 —— 当作"等扫码"，下个 tick 再试
        session.lastError = e.message || String(e);
        console.warn(`[setup ${uid}] qr-check transient: ${e.message}`);
        return json(res, 200, { code: session.code || 801, status: session.status || "waiting", debug: publicSessionDebug(session) });
      }
      const code = r.body.code;
      session.code = code;
      session.lastError = "";
      console.log(`[setup ${uid}] qr-check code=${code} cookie?=${!!r.body.cookie}`);
      // 800 = 二维码过期。不要后台自动换码，网易云容易把频繁换码 + 轮询判成异常环境。
      if (code === 800) {
        session.status = "expired";
        return json(res, 200, { code: 800, status: "expired", debug: publicSessionDebug(session) });
      }
      // 803 = 已确认登录
      if (code === 803) {
        session.status = "done";
        session.cookie = r.body.cookie;
        session.profile = await saveVerifiedCookie(t, uid, session.cookie, "qr-login");
        return json(res, 200, { code, status: "done", profile: { nickname: session.profile.nickname, userId: session.profile.userId }, debug: publicSessionDebug(session) });
      }
      // 801 = 等扫码 / 802 = 已扫码等手机点确认
      session.status = code === 802 ? "scanned" : "waiting";
      return json(res, 200, { code, status: session.status, debug: publicSessionDebug(session) });
    }

    // —— 备用登录：手机号短信验证码。用于二维码被网易云 App 风控拦截的情况。
    if (p === "/api/setup/sms-send" && req.method === "POST") {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: "bad json" }); }
      const phone = normalizePhone(parsed.phone);
      const ctcode = normalizeCountryCode(parsed.ctcode || parsed.countrycode);
      if (!phone || phone.length < 6) return json(res, 400, { error: "请输入有效手机号" });
      const r = await ncmCall(ncm.captcha_sent, { phone, ctcode, cookie: LOGIN_DEVICE_HINT });
      if (r.body?.code !== 200) {
        return json(res, 400, { error: r.body?.message || r.body?.msg || "验证码发送失败" });
      }
      console.log(`[setup ${uid}] sms sent: +${ctcode} ${phone.slice(0, 3)}****${phone.slice(-4)}`);
      return json(res, 200, { ok: true });
    }

    if (p === "/api/setup/sms-login" && req.method === "POST") {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: "bad json" }); }
      const phone = normalizePhone(parsed.phone);
      const captcha = normalizePhone(parsed.captcha || parsed.code);
      const countrycode = normalizeCountryCode(parsed.ctcode || parsed.countrycode);
      if (!phone || phone.length < 6) return json(res, 400, { error: "请输入有效手机号" });
      if (!captcha || captcha.length < 4) return json(res, 400, { error: "请输入短信验证码" });
      const r = await ncmCall(ncm.login_cellphone, { phone, captcha, countrycode, cookie: LOGIN_DEVICE_HINT });
      if (r.body?.code !== 200 || !r.body?.cookie) {
        return json(res, 400, { error: r.body?.message || r.body?.msg || "验证码登录失败" });
      }
      const profile = await saveVerifiedCookie(t, uid, r.body.cookie, "sms-login");
      return json(res, 200, { ok: true, profile: { nickname: profile.nickname, userId: profile.userId } });
    }

    // —— 最稳兜底：不用登录，只用网易云 UID / 主页链接读取公开歌单。
    if (p === "/api/setup/public-import" && req.method === "POST") {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: "bad json" }); }
      const ncmUid = normalizeNcmUserId(parsed.uid || parsed.url);
      if (!ncmUid) {
        return json(res, 400, { error: "请输入网易云用户 ID，或粘贴个人主页链接" });
      }
      const data = await fetchPublicUserDump(ncmUid);
      if (!data.created.length && !data.subscribed.length) {
        return json(res, 400, { error: "没有读到公开歌单。请确认主页链接正确，且歌单不是全部私密。" });
      }
      await fs.writeFile(t.playlistsJsonPath, JSON.stringify(data, null, 2), "utf8");
      t.loadWelcomePool();
      if (data.profile.nickname) {
        t.displayName = data.profile.nickname;
        t.settings.nickname = data.profile.nickname;
        t.saveSettings();
      }
      await persistUserFiles(uid);
      console.log(`[setup ${uid}] public-import ok: ${data.profile.nickname || ncmUid} (${data.created.length} created)`);
      return json(res, 200, {
        ok: true,
        nickname: data.profile.nickname || `网易云用户 ${ncmUid}`,
        created: data.created.length,
        subscribed: data.subscribed.length,
        week: 0,
        allTime: 0,
        publicOnly: true,
      });
    }

    // —— 扫码被网易云风控时的备用：粘贴 Web Cookie / MUSIC_U
    if (p === "/api/setup/cookie-login" && req.method === "POST") {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: "bad json" }); }
      const cookie = normalizeNcmCookie(parsed.cookie);
      if (!cookie || !/MUSIC_U=/.test(cookie)) {
        return json(res, 400, { error: "请粘贴完整 Cookie，或至少包含 MUSIC_U=..." });
      }
      const profile = await saveVerifiedCookie(t, uid, cookie, "cookie-login");
      return json(res, 200, { ok: true, profile: { nickname: profile.nickname, userId: profile.userId } });
    }

    // —— 拉歌单 + 写 playlists.json/md
    if (p === "/api/setup/import" && req.method === "POST") {
      const cookie = t.readFile(t.cookiePath).trim();
      if (!cookie) return json(res, 400, { error: "未登录" });
      const status = await ncmCall(ncm.login_status, { cookie });
      const profile = status.body.data.profile;
      if (!profile?.userId) return json(res, 400, { error: "登录态失效" });
      const data = await fetchUserDump(profile.userId, cookie);
      await fs.writeFile(t.playlistsJsonPath, JSON.stringify(data, null, 2), "utf8");
      // 刷新 welcome pool
      t.loadWelcomePool();
      // 顺手保存 displayName
      if (profile.nickname) {
        t.displayName = profile.nickname;
        t.settings.nickname = profile.nickname;
        t.saveSettings();
      }
      await persistUserFiles(uid);
      return json(res, 200, {
        ok: true,
        nickname: profile.nickname,
        created: data.created.length,
        week: data.week.length,
        allTime: data.allTime.length,
      });
    }

    // —— 启动 Seed 写 taste 草稿（异步：立即返回，后台跑）
    if (p === "/api/setup/draft" && req.method === "POST") {
      const dataRaw = t.readFile(t.playlistsJsonPath);
      if (!dataRaw) return json(res, 400, { error: "请先导入歌单" });
      const existing = draftJobs.get(uid);
      if (existing && existing.status === "pending") {
        return json(res, 200, { status: "pending" });
      }
      draftJobs.set(uid, { status: "pending", startedAt: Date.now() });
      const dump = buildCompactDump(JSON.parse(dataRaw));
      console.log(`[setup ${uid}] draft 启动（后台跑）`);
      // 后台跑，不阻塞响应
      (async () => {
        try {
          // 最多重试 3 次（模型偶尔输出伪装话术）
          let md = "";
          for (let i = 0; i < 3; i++) {
            md = await askRaw({ system: TASTE_DRAFT_SYSTEM, user: dump, timeoutMs: 300_000 });
            md = md.replace(/^```\w*\n?/g, "").replace(/\n?```$/g, "").trim();
            // 模型伪装"已经写好文件"的特征 + 必须以约定开头
            const fakeIndicators = /已(经)?(为你|帮你)?(写好|创建|保存|生成|起草).{0,30}文件|文件已(写好|起草|生成|保存)|内容.{0,10}(在|位于).{0,30}\.md|等待你确认|同意写入权限|请在权限提示|已存到|权限提示中确认/;
            const startsOk = md.startsWith("# ");
            if (md.length > 200 && startsOk && !fakeIndicators.test(md.slice(0, 400))) break;
            console.warn(`[setup ${uid}] draft 第 ${i + 1} 次返回伪装文本，重试`);
            md = "";
          }
          if (!md.trim()) {
            draftJobs.set(uid, { status: "error", error: "模型多次返回伪装话术，没拿到真正的侧写内容" });
            return;
          }
          draftJobs.set(uid, { status: "done", result: md });
          console.log(`[setup ${uid}] draft 完成（${md.length} 字）`);
        } catch (e) {
          console.warn(`[setup ${uid}] draft 失败: ${e.message}`);
          draftJobs.set(uid, { status: "error", error: e.message || String(e) });
        }
      })();
      return json(res, 200, { status: "pending" });
    }

    // —— 轮询草稿状态
    if (p === "/api/setup/draft-check" && req.method === "GET") {
      const job = draftJobs.get(uid);
      if (!job) return json(res, 404, { status: "none" });
      if (job.status === "done") {
        // 取走结果后保留状态一段时间，避免重复 POST
        return json(res, 200, { status: "done", taste: job.result });
      }
      if (job.status === "error") {
        return json(res, 200, { status: "error", error: job.error });
      }
      return json(res, 200, { status: "pending", elapsedSec: Math.round((Date.now() - job.startedAt) / 1000) });
    }

    // —— 保存最终 taste.md
    if (p === "/api/setup/save" && req.method === "POST") {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: "bad json" }); }
      const taste = String(parsed.taste || "").trim();
      if (!taste) return json(res, 400, { error: "taste 不能空" });
      if (taste.length < 150) return json(res, 400, { error: "内容太短，不像有效侧写" });
      const fake = /已(经)?(为你|帮你)?(写好|起草|创建|生成|保存).{0,30}文件|文件已(写好|起草|生成|保存)|内容.{0,10}(在|位于).{0,30}\.md|等待你确认|同意写入权限|请在权限提示|权限提示中确认|文件写入需要你批准|批准写入|可以复制保存为|我没有任何实际听歌行为/;
      if (fake.test(taste.slice(0, 400))) {
        return json(res, 400, { error: "这是模型的伪装话术不是真侧写，请点'重新写一份'再来" });
      }
      if (!/^#\s/.test(taste)) {
        return json(res, 400, { error: "请以 # 开头的 markdown 起笔（点'重新写一份'让 Uni radio 重出）" });
      }
      await fs.writeFile(t.tastePath, taste, "utf8");
      // 顺便写一份默认 routines.md（如果没有）
      try { await fs.access(t.routinesPath); }
      catch {
        await fs.writeFile(t.routinesPath, "# 日常节律\n\n- 07:00 起床\n- 09:00 早间节目\n- 18:30 通勤\n- 23:00 深夜\n", "utf8");
      }
      await persistUserFiles(uid);
      console.log(`[setup ${uid}] taste 已保存 ${taste.length} 字`);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "unknown setup endpoint" });
  } catch (e) {
    console.error(`[setup ${uid}] ${p}: ${e.message}`);
    json(res, 500, { error: e.message || String(e) });
  }
}
