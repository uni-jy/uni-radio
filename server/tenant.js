// 每个用户的状态都装在一个 Tenant 实例里。
// uid 通过 cookie 持久化在浏览器，server 进程内 Map<uid, Tenant>。
import fs from "node:fs";
import path from "node:path";
import { USERS_DIR } from "./paths.js";

const _tenants = new Map();

export const OWNER_UID = "owner";  // 宿主自己的固定 uid

export function getTenant(uid) {
  if (!uid) throw new Error("uid required");
  if (!_tenants.has(uid)) _tenants.set(uid, new Tenant(uid));
  else _tenants.get(uid).reloadFromDisk();
  return _tenants.get(uid);
}

export function hasTenant(uid) { return _tenants.has(uid); }
export function listTenants() { return [..._tenants.values()]; }

/** 朋友访问时分配的 uid（cookie 32 位十六进制） */
export function newGuestUid() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

export class Tenant {
  constructor(uid) {
    this.uid = uid;
    this.displayName = uid === OWNER_UID ? "Owner" : "Friend-" + uid.slice(0, 6);
    this.dir = path.join(USERS_DIR, uid);
    fs.mkdirSync(this.dir, { recursive: true });

    // —— 持久化文件路径
    this.tastePath = path.join(this.dir, "taste.md");
    this.routinesPath = path.join(this.dir, "routines.md");
    this.playlistsJsonPath = path.join(this.dir, "playlists.json");
    this.playlistsMdPath = path.join(this.dir, "playlists.md");
    this.feedbackPath = path.join(this.dir, "feedback.jsonl");
    this.playsPath = path.join(this.dir, "plays.jsonl");
    this.playbackStatePath = path.join(this.dir, "playback-state.json");
    this.cookiePath = path.join(this.dir, "ncm-cookie.txt");
    this.settingsPath = path.join(this.dir, "settings.json");

    // —— 播放状态
    this.nowPlaying = { title: "Unico 待机", artist: "—", url: null, source: "local" };
    this.playState = { paused: true };
    this.queue = [];
    this.prefetching = false;
    this.prefetchToken = 0;
    this.waitingForNext = false;
    this.moodHint = "";
    this.intentCandidates = [];
    this.listeningContext = {
      mood: "",
      scene: "",
      energy: "",
      avoid: [],
      updatedAt: 0,
    };
    this.lastGuideAt = 0;

    this.recentPlays = [];
    this.dislikedTracks = new Set();
    // 5 首循环槽位：0,1 = 用户听得少的歌；2,3 = 没听过；4 = 用户听得多
    this.cycleSlot = 0;
    // —— 客户端
    this.clients = new Set();
    this.activeClient = null;

    // —— 计时器
    this._midSongTimer = null;
    this._teaseTimer = null;
    this._eventToken = 0;
    this._lyricToken = 0;
    this._streamToken = 0;

    // —— 设置（包括用户挑的 fish voice id）
    this.settings = this.loadSettings();

    this.welcomePool = [];
    this.loadWelcomePool();
  }

  reloadFromDisk() {
    this.settings = this.loadSettings();
    this.loadWelcomePool({ log: false });
  }

  loadSettings() {
    try { return JSON.parse(fs.readFileSync(this.settingsPath, "utf8")); }
    catch { return {}; }
  }
  saveSettings() {
    try { fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2)); }
    catch (e) { console.warn(`[tenant ${this.uid}] saveSettings: ${e.message}`); }
  }

  /** 首次设置是否完成（有真正的 taste.md + playlists.json） */
  hasSetup() {
    if (!fs.existsSync(this.tastePath)) return false;
    if (!fs.existsSync(this.playlistsJsonPath)) return false;
    const taste = this.readFile(this.tastePath);
    if (!taste || taste.length < 150) return false;
    // 检测模型的伪装话术 —— 这些都是无效 taste
    const fake = /已(经)?(为你|帮你)?(写好|起草|创建|生成|保存).{0,30}文件|文件已(写好|起草|生成|保存)|内容.{0,10}(在|位于).{0,30}\.md|等待你确认|同意写入权限|请在权限提示|权限提示中确认|文件写入需要你批准|批准写入|可以复制保存为|我没有任何实际听歌行为/;
    if (fake.test(taste.slice(0, 400))) return false;
    // 必须以 markdown heading 起头（真 taste 都是这样）
    if (!/^#\s/.test(taste.trim())) return false;
    return true;
  }

  readFile(p, fallback = "") {
    try { return fs.readFileSync(p, "utf8"); } catch { return fallback; }
  }

  /** 解析 playlists.json，分出"听得多" / "听得少" 两档候选 + 已知歌手 */
  taasteSignals() {
    try {
      const data = JSON.parse(fs.readFileSync(this.playlistsJsonPath, "utf8"));
      const blocked = /白噪音|Alpha|Thunderstorm|睡眠|White Noise/i;
      const isAvail = (s) => s?.title && s?.artist && !blocked.test(s.title) && !blocked.test(s.artist);
      const playlistTracks = (data.created || [])
        .flatMap(p => (p.topTracks || []).map(t => ({ ...t, playCount: p.playCount || 0, score: p.playCount || 0 })));
      // 周榜 + 全时榜 + 公开歌单曲目合并去重 + 按 playCount/score 排序
      const all = [...(data.allTime || []), ...(data.week || []), ...playlistTracks].filter(isAvail);
      const seen = new Set();
      const dedup = [];
      for (const s of all) {
        const k = s.title + "|" + s.artist;
        if (seen.has(k)) continue;
        seen.add(k);
        dedup.push(s);
      }
      dedup.sort((a, b) => (b.playCount || b.score || 0) - (a.playCount || a.score || 0));
      const high = dedup.slice(0, 15);                               // 听得多
      const mid = dedup.slice(15, 60);                               // 听得不算多
      const knownArtists = [...new Set(dedup.flatMap(s => s.artist.split(/ ?\/ ?/)))].slice(0, 30);
      // 自建歌单名字也是品味信号（"通勤" "睡前" "想她" 这种）
      const playlistNames = (data.created || []).map(p => p.name).filter(Boolean);
      return { high, mid, knownArtists, playlistNames };
    } catch {
      return { high: [], mid: [], knownArtists: [], playlistNames: [] };
    }
  }

  loadWelcomePool({ log = true } = {}) {
    try {
      const raw = fs.readFileSync(this.playlistsJsonPath, "utf8");
      const data = JSON.parse(raw);
      const blocked = /白噪音|Alpha|Thunderstorm|Ankhagram|Sadness|睡眠|White Noise/i;
      const cap = (arr) => (arr || []).slice(0, 40);
      const playlistTracks = (data.created || [])
        .flatMap(p => (p.topTracks || []).map(t => ({ ...t, playCount: p.playCount || 0 })));
      const merged = [...cap(data.allTime), ...cap(data.week), ...cap(playlistTracks)];
      const seen = new Set();
      this.welcomePool = merged
        .filter(s => s?.title && s?.artist)
        .filter(s => !blocked.test(s.title) && !blocked.test(s.artist))
        .filter(s => {
          const k = s.title + "|" + s.artist;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 50)
        .map(s => `${s.title} ${s.artist}`);
      if (log) console.log(`[tenant ${this.uid}] welcome pool: ${this.welcomePool.length}`);
    } catch {
      this.welcomePool = ["晚春 腰乐队", "山谷 東方红Red East", "理想三旬 陈鸿宇"];
    }
  }

  /** 给自己的所有 WS client 广播一条消息（不会泄露给别的租户） */
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(s);
    }
  }

  invalidatePrefetch() {
    this.prefetchToken++;
    this.queue = [];
  }

  clearTrackEvents() {
    if (this._midSongTimer) { clearTimeout(this._midSongTimer); this._midSongTimer = null; }
    if (this._teaseTimer) { clearTimeout(this._teaseTimer); this._teaseTimer = null; }
    this._eventToken++;
  }

  rememberPlayed(track) {
    if (!track || !track.title) return;
    this.recentPlays.unshift({ title: track.title, artist: track.artist, ts: Date.now() });
    if (this.recentPlays.length > 30) this.recentPlays.length = 30;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      title: track.title,
      artist: track.artist,
      songId: track.id || "",
      source: track.source || "",
      exploration: !!track.exploration,
    });
    try { fs.appendFileSync(this.playsPath, line + "\n"); }
    catch (e) { console.warn(`[tenant ${this.uid}] plays write: ${e.message}`); }
  }

  loadPlayedTracks(limit = 500) {
    try {
      const lines = fs.readFileSync(this.playsPath, "utf8").trim().split("\n").filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line)).filter(t => t?.title && t?.artist);
    } catch {
      return [];
    }
  }

  recordFeedback(action, track, extra = {}) {
    if (!track || !track.title) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action, title: track.title, artist: track.artist, songId: track.id || "",
      ...extra,
    });
    try { fs.appendFileSync(this.feedbackPath, line + "\n"); }
    catch (e) { console.warn(`[tenant ${this.uid}] feedback write: ${e.message}`); }
  }

  notifyRoles() {
    for (const c of this.clients) {
      if (c.readyState === 1) c.send(JSON.stringify({ type: "role", active: c === this.activeClient }));
    }
  }
  setActiveClient(ws) {
    this.activeClient = ws;
    this.notifyRoles();
  }
}
