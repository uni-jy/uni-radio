// Uni radio PWA player
import { unlockAudioElement } from "./audio-unlock.js";
import { createBufferedSender } from "./ws-send.js";
import { buildPopoutFeatures, buildWindowUrl, getInitialWindowMode, setWindowModePreference } from "./window-mode.js";
const $ = (id) => document.getElementById(id);
const music = $("audio-music");
const voice = $("audio-voice");
const stream = $("stream");

const DUCK_FACTOR = 0.25;

// —— 用户偏好（localStorage 持久化）
const prefs = {
  musicVolume: parseFloat(localStorage.getItem("unico.musicVolume") ?? "1"),
  voiceVolume: parseFloat(localStorage.getItem("unico.voiceVolume") ?? "1"),
  mode: localStorage.getItem("unico.mode") || "chat",       // chat | silent
  theme: localStorage.getItem("unico.theme") || "amber",
  midsong: localStorage.getItem("unico.midsong") !== "0",
  ttsVoice: localStorage.getItem("unico.ttsVoice") || "default",
  scene: localStorage.getItem("unico.scene") || "onair",
};
function savePrefs() {
  localStorage.setItem("unico.musicVolume", prefs.musicVolume);
  localStorage.setItem("unico.voiceVolume", prefs.voiceVolume);
  localStorage.setItem("unico.mode", prefs.mode);
  localStorage.setItem("unico.theme", prefs.theme);
  localStorage.setItem("unico.midsong", prefs.midsong ? "1" : "0");
  localStorage.setItem("unico.ttsVoice", prefs.ttsVoice);
  localStorage.setItem("unico.scene", prefs.scene);
}

function setWindowMode(enabled, { persist = true } = {}) {
  document.body.classList.toggle("window-mode", !!enabled);
  document.querySelectorAll("#btn-window-mode, #btn-window-inline").forEach((btn) => {
    if (!btn) return;
    btn.classList.toggle("active", !!enabled);
    btn.title = enabled ? "退出窗口模式" : "窗口模式";
    btn.setAttribute("aria-pressed", enabled ? "true" : "false");
  });
  if (persist) setWindowModePreference(!!enabled);
}

function toggleWindowMode() {
  const inPopout = new URLSearchParams(location.search).get("window") === "1";
  if (inPopout) {
    setWindowMode(false);
    setWindowModePreference(false);
    location.href = location.origin + location.pathname;
    return;
  }

  if (popoutWindow && !popoutWindow.closed) {
    popoutWindow.focus();
    return;
  }

  const url = buildWindowUrl(location.href);
  popoutWindow = window.open(url, "unico-player-window", buildPopoutFeatures());
  if (popoutWindow) {
    popoutWindow.focus();
  } else {
    setWindowMode(true);
    history.replaceState(null, "", url);
  }
}

setWindowMode(getInitialWindowMode(location.search), { persist: false });

let started = false;
let serverPaused = true;
let ws;
let currentTrack = null;
let voiceTimer = null;
let isActive = false;
let isDucking = false;
let restoredPlayback = null;
let savePlaybackTimer = null;
let popoutWindow = null;
let seedConnected = null;
const bufferedSender = createBufferedSender(() => ws);

// —— 会话统计
const session = {
  startedAt: null,
  played: 0,       // 完整播过的歌
  skipped: 0,
  chats: 0,        // 我发出的对话
  likes: 0,
  dislikes: 0,
  queue: [],
  queueLoading: false,
  recent: [],      // [{title, artist, picUrl, fb}]  fb: 'like'|'dislike'|'skip'|null
  feedbackLog: [], // [{action, title, artist, ts}]
};

// ===== scene shell =====
const mobileMenuButton = $("mobile-menu-button");
const mobileSceneMenu = $("mobile-scene-menu");

function setScene(scene, { persist = true } = {}) {
  const next = scene || "onair";
  const panel = document.querySelector(`[data-scene-panel="${next}"]`);
  if (!panel) {
    if (next !== "onair") return setScene("onair", { persist });
    return;
  }
  document.querySelectorAll("[data-scene-panel]").forEach((el) => {
    el.classList.toggle("active", el.dataset.scenePanel === next);
  });
  document.querySelectorAll(".scene-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.scene === next);
  });
  if (persist) {
    prefs.scene = next;
    savePrefs();
  }
  mobileSceneMenu?.classList.remove("open");
  mobileMenuButton?.classList.remove("open");
  mobileMenuButton?.setAttribute("aria-expanded", "false");
  setTimeout(resizeWave, 0);
}

document.querySelectorAll("[data-scene]").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    setScene(el.dataset.scene);
  });
});

mobileMenuButton?.addEventListener("click", () => {
  const open = !mobileSceneMenu.classList.contains("open");
  mobileSceneMenu.classList.toggle("open", open);
  mobileMenuButton.classList.toggle("open", open);
  mobileMenuButton.setAttribute("aria-expanded", open ? "true" : "false");
});

setScene(prefs.scene, { persist: false });

// ===== bubble stream =====
function bubble(kind, text, who) {
  const el = document.createElement("div");
  el.className = "bubble " + kind;
  if (who) {
    const w = document.createElement("div");
    w.className = "who";
    w.textContent = who;
    el.appendChild(w);
  }
  const t = document.createElement("div");
  t.textContent = text;
  el.appendChild(t);
  stream.appendChild(el);
  while (stream.children.length > 80) stream.removeChild(stream.firstChild);
  stream.scrollTop = stream.scrollHeight;
}
function sys(text) { bubble("system", text); }
function you(text) { bubble("you", text); }
function dj(text, kind, who) { bubble("dj " + (kind || ""), text, who || "Uni radio"); }
function nowLine(text) { bubble("now", text); }

function startClientSession() {
  if (started) return;
  started = true;
  setControlsActive(true);
  $("btn-start").disabled = true;
  $("btn-start").hidden = true;
  prepareVoicePlayback();
  music.play().then(() => music.pause()).catch(() => {});
  send({ type: "claim" });
  send({ type: "control", action: "start-radio" });
  startSession();
}

function sendChatText(text) {
  const value = String(text || "").trim();
  if (!value || !ws || ws.readyState !== 1) return;
  send({ type: "chat", text: value });
  if (!started) startClientSession();
}

function send(obj) {
  bufferedSender.send(obj);
}

// ===== thinking state =====
function setThinking(text) {
  const el = $("thinking-state");
  if (text) { el.textContent = text; el.classList.add("show"); }
  else el.classList.remove("show");
}

// ===== volume control =====
let _volFadeRAF = null;
function fadeMusicTo(target, duration = 350) {
  if (_volFadeRAF) cancelAnimationFrame(_volFadeRAF);
  const start = music.volume;
  const t0 = performance.now();
  function step() {
    const elapsed = performance.now() - t0;
    const k = Math.min(1, elapsed / duration);
    const eased = 1 - Math.pow(1 - k, 3);
    music.volume = start + (target - start) * eased;
    if (k < 1) _volFadeRAF = requestAnimationFrame(step);
    else _volFadeRAF = null;
  }
  step();
}
function applyVolumes() {
  music.volume = prefs.musicVolume * (isDucking ? DUCK_FACTOR : 1);
  voice.volume = prefs.voiceVolume;
}
let voiceMuteWarningShown = false;
function warnIfVoiceMuted() {
  if (prefs.voiceVolume > 0) {
    voiceMuteWarningShown = false;
    return;
  }
  if (voiceMuteWarningShown) return;
  voiceMuteWarningShown = true;
  sys("DJ 播报音量是 0，请到 MIXER 把 DJ 播报音量调高。");
}
function setDuck(on) {
  const wasDucking = isDucking;
  isDucking = !!on;
  $("voice-pulse")?.classList.toggle("active", isDucking);
  voice.volume = prefs.voiceVolume;
  if (wasDucking === isDucking) return;
  fadeMusicTo(prefs.musicVolume * (isDucking ? DUCK_FACTOR : 1));
}
applyVolumes();

function prepareVoicePlayback() {
  ensureAudioGraph();
  resumeAudioCtx();
  void unlockAudioElement(voice).finally(applyVolumes);
}

// ===== streaming DJ chunks =====
// 每段 stream（一首歌的 intro 或一条 talk 回复）一个 live bubble + 一个音频队列
const djStream = {
  trackId: null,
  kind: null,         // 'intro' | 'talk'
  bubbleEl: null,
  textEl: null,
  audioQueue: [],     // [{idx, sayUrl}]
  playing: false,
  finalized: false,
};

function resetDjStream(trackId, kind) {
  // 旧 stream 还在播 → 立刻打断（用户主动 chat 时希望听到回复而不是继续 intro）
  if (djStream.playing) {
    try { voice.pause(); voice.removeAttribute("src"); } catch {}
    djStream.playing = false;
  }
  // 旧 bubble 没收尾就强制收尾
  if (djStream.bubbleEl && !djStream.finalized) finalizeDjBubble();
  djStream.trackId = trackId;
  djStream.kind = kind || null;
  djStream.bubbleEl = null;
  djStream.textEl = null;
  djStream.audioQueue = [];
  djStream.finalized = false;
}

function ensureDjBubble() {
  if (djStream.bubbleEl) return djStream.bubbleEl;
  const el = document.createElement("div");
  el.className = "bubble dj streaming " + (djStream.kind === "talk" ? "talk" : "");
  const w = document.createElement("div");
  w.className = "who";
  w.textContent = djStream.kind === "talk" ? "Uni radio · 聊天" : "Uni radio · 介绍";
  el.appendChild(w);
  const t = document.createElement("div");
  t.className = "dj-text";
  t.textContent = "";
  el.appendChild(t);
  const caret = document.createElement("span");
  caret.className = "dj-caret";
  caret.textContent = "▍";
  el.appendChild(caret);
  stream.appendChild(el);
  while (stream.children.length > 80) stream.removeChild(stream.firstChild);
  stream.scrollTop = stream.scrollHeight;
  djStream.bubbleEl = el;
  djStream.textEl = t;
  return el;
}

function appendDjText(text) {
  ensureDjBubble();
  djStream.textEl.textContent += (djStream.textEl.textContent ? " " : "") + text;
  stream.scrollTop = stream.scrollHeight;
}

function finalizeDjBubble() {
  if (!djStream.bubbleEl) return;
  djStream.bubbleEl.classList.remove("streaming");
  const caret = djStream.bubbleEl.querySelector(".dj-caret");
  if (caret) caret.remove();
}

function queueDjAudio(idx, sayUrl) {
  if (!sayUrl) return;
  djStream.audioQueue.push({ idx, sayUrl });
  // 保持顺序：按 idx 升序播
  djStream.audioQueue.sort((a, b) => a.idx - b.idx);
  if (!djStream.playing) playNextDjAudio();
}

async function playNextDjAudio() {
  if (djStream.playing) return;
  const item = djStream.audioQueue.shift();
  if (!item) {
    // 没有下一段：如果不再有更多 chunk，松开 duck
    if (djStream.finalized) setDuck(false);
    return;
  }
  djStream.playing = true;
  voice.src = item.sayUrl;
  try {
    setDuck(true);
    await voice.play();
  } catch (e) {
    if (!isBenignAbort(e)) sys("dj chunk 播放失败: " + e.message);
    djStream.playing = false;
    setDuck(false);
    // 失败不阻塞，继续下一段
    setTimeout(playNextDjAudio, 100);
  }
}

voice.addEventListener("ended", () => {
  if (djStream.playing) {
    djStream.playing = false;
    // 还有就接着播，没有就松开 duck（保留旧逻辑也会触发 setDuck(false)）
    if (djStream.audioQueue.length) {
      playNextDjAudio();
    } else if (djStream.finalized) {
      setDuck(false);
    }
  } else {
    setDuck(false);
  }
});

// ===== voice scheduling =====
let pendingSay = null;
function clearVoiceSchedule() {
  if (voiceTimer) { clearTimeout(voiceTimer); voiceTimer = null; }
  pendingSay = null;
  if (!voice.paused) { try { voice.pause(); } catch {} }
  voice.removeAttribute("src");
  setDuck(false);
}
function isBenignAbort(e) {
  if (!e) return false;
  return e.name === "AbortError" ||
    /interrupted by a call to pause|aborted by the user/i.test(e.message || "");
}

function reportPlaybackError(e) {
  if (isBenignAbort(e)) return;
  console.warn("[audio] playback failed", e);
  if (e?.name === "NotAllowedError") {
    if (document.getElementById("audio-resume")) return;
    const notice = document.createElement("div");
    notice.className = "bubble system";
    notice.id = "audio-resume";
    notice.textContent = "浏览器暂停了声音。";
    const retry = document.createElement("button");
    retry.textContent = "点击恢复播放";
    retry.addEventListener("click", () => {
      audioCtx?.resume();
      const attempts = [music.play()];
      if (voice.getAttribute("src")) attempts.push(voice.play());
      Promise.all(attempts).then(() => notice.remove()).catch(reportPlaybackError);
    });
    notice.appendChild(retry);
    stream.appendChild(notice);
    stream.scrollTop = stream.scrollHeight;
  } else {
    sys("这段音频暂时无法播放，可以重试或切换下一首。");
  }
}

function renderSeedBadge(track = currentTrack) {
  const badge = $("src-badge");
  if (!badge) return;
  if (seedConnected === null) {
    badge.textContent = "Seed 待连接";
    return;
  }
  if (seedConnected === false) {
    badge.textContent = "↺ Seed 重连中";
    return;
  }
  badge.textContent = "✓ Seed 已连接";
}

async function startSayNow(sayUrl) {
  if (!sayUrl) return;
  voice.src = sayUrl;
  try { setDuck(true); await voice.play(); }
  catch (e) {
    if (!isBenignAbort(e)) sys("voice 播放失败: " + e.message);
    setDuck(false);
  }
}
function scheduleVoice(sayUrl, delayMs) {
  clearVoiceSchedule();
  if (!sayUrl) return;
  const delay = Math.max(0, delayMs ?? 0);
  if (delay === 0) {
    if (!music.paused && !music.ended && music.currentTime > 0) startSayNow(sayUrl);
    else pendingSay = sayUrl;
  } else {
    voiceTimer = setTimeout(() => {
      if (!currentTrack || currentTrack.sayUrl !== sayUrl) return;
      startSayNow(sayUrl);
    }, delay);
  }
}
music.addEventListener("playing", () => {
  if (pendingSay && currentTrack && currentTrack.sayUrl === pendingSay) {
    const s = pendingSay;
    pendingSay = null;
    startSayNow(s);
  }
  updateVinylSpin();
});
music.addEventListener("pause", updateVinylSpin);
music.addEventListener("play", updateVinylSpin);
// 注：voice.ended 的统一处理在 streaming DJ 块里，避免提前 setDuck(false) 打断队列
voice.addEventListener("pause", () => { if (voice.ended && !djStream.playing && !djStream.audioQueue.length) setDuck(false); });

async function playOverlay(sayUrl) {
  if (!sayUrl || !isActive) return;
  if (voiceTimer) { clearTimeout(voiceTimer); voiceTimer = null; }
  try {
    voice.src = sayUrl;
    setDuck(true);
    await voice.play();
  } catch (e) { if (!isBenignAbort(e)) sys("overlay 失败: " + e.message); setDuck(false); }
}

// ===== vinyl rotation =====
function updateVinylSpin() {
  const v = document.getElementById("vinyl");
  const playing = !music.paused && !music.ended && currentTrack && currentTrack.url;
  v.classList.toggle("playing", !!playing);
}

// ===== lyric =====
let lyricLines = [];
let lyricIdx = -1;
function setLyric(lines) {
  lyricLines = lines || [];
  lyricIdx = -1;
  if (!lyricLines.length) {
    $("np-lyric").classList.remove("show");
    $("silent-lyric").classList.remove("show");
    $("lyric-prev").textContent = "";
    $("lyric-next").textContent = "";
  }
}
function tickLyric() {
  if (!lyricLines.length) return;
  const t = music.currentTime * 1000;
  let idx = -1;
  for (let i = 0; i < lyricLines.length; i++) {
    if (lyricLines[i].t <= t) idx = i; else break;
  }
  if (idx !== lyricIdx) {
    lyricIdx = idx;
    const now = idx >= 0 ? lyricLines[idx].text : "";
    const prev = idx > 0 ? lyricLines[idx - 1].text : "";
    const next = idx < lyricLines.length - 1 ? lyricLines[idx + 1].text : "";
    const cur = $("np-lyric");
    cur.textContent = now;
    if (now) cur.classList.add("show"); else cur.classList.remove("show");
    $("lyric-prev").textContent = prev;
    $("lyric-next").textContent = next;
    // 静默视图
    const sil = $("silent-lyric");
    sil.textContent = now;
    if (now) sil.classList.add("show"); else sil.classList.remove("show");
  }
}
music.addEventListener("timeupdate", tickLyric);
setInterval(() => {
  if (currentTrack?.url) savePlaybackStateSoon();
}, 15000);

// ===== wave canvas =====
const canvas = $("wave");
const ctx2d = canvas.getContext("2d");
let waveT0 = performance.now();
let audioCtx = null, musicSource = null, voiceSource = null, analyser = null, freqData = null;
const BARS = 96;
const barSmooth = new Float32Array(BARS);

function resizeWave() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", () => {
  resizeWave();
  syncNowTitleMarquee();
});
setTimeout(resizeWave, 0);

function ensureAudioGraph() {
  if (audioCtx) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    musicSource = audioCtx.createMediaElementSource(music);
    voiceSource = audioCtx.createMediaElementSource(voice);
    musicSource.connect(analyser);
    voiceSource.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (e) {
    console.warn("AudioContext init 失败：", e.message);
    audioCtx = null;
  }
}

function resumeAudioCtx() {
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
}

function drawWave() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx2d.clearRect(0, 0, w, h);
  const playing = !music.paused && !music.ended && currentTrack && currentTrack.url;
  const t = (performance.now() - waveT0) / 1000;
  const gap = 2;
  const bw = (w - (BARS - 1) * gap) / BARS;

  let bins = null;
  if (analyser && playing) {
    analyser.getByteFrequencyData(freqData);
    bins = freqData;
  }

  for (let i = 0; i < BARS; i++) {
    let target;
    if (bins) {
      const span = Math.floor(bins.length / BARS);
      let sum = 0, max = 0;
      const start = i * span;
      for (let k = 0; k < span; k++) {
        const v = bins[start + k] || 0;
        sum += v; if (v > max) max = v;
      }
      const v = (sum / span * 0.6 + max * 0.4) / 255;
      const weight = 0.6 + 0.4 * Math.sin((i / (BARS - 1)) * Math.PI);
      target = Math.pow(v, 0.85) * weight;
    } else {
      const phase = i * 0.45;
      const a = Math.sin(t * 3.1 + phase) * 0.5 + Math.sin(t * 1.7 + phase * 1.3) * 0.3;
      const idle = playing ? 0.4 : 0.12;
      target = (0.5 + a * 0.5) * idle;
    }
    const prev = barSmooth[i] || 0;
    const attack = 0.55, release = 0.12;
    barSmooth[i] = target > prev ? prev + (target - prev) * attack : prev + (target - prev) * release;

    const amp = barSmooth[i];
    const barH = Math.max(2, amp * h * 1.2);
    const x = i * (bw + gap);
    const y = (h - barH) / 2;
    const fade = 1 - Math.abs((i / (BARS - 1)) - 0.5) * 1.4;
    const alpha = 0.4 + 0.6 * Math.max(0.15, fade);
    const shade = Math.round(170 + amp * 85);
    ctx2d.fillStyle = `rgba(${shade}, ${shade}, ${shade}, ${alpha})`;
    ctx2d.beginPath();
    const rr = Math.min(bw / 2, 2);
    if (ctx2d.roundRect) ctx2d.roundRect(x, y, bw, barH, rr);
    else ctx2d.rect(x, y, bw, barH);
    ctx2d.fill();
  }
  requestAnimationFrame(drawWave);
}
requestAnimationFrame(drawWave);

// ===== now / cover =====
function setCover(url) {
  const img = $("cover");
  if (url) { img.src = url; img.style.display = ""; }
  else { img.removeAttribute("src"); }
  // 静默视图大封面
  const sc = $("silent-cover");
  if (url) { sc.style.backgroundImage = `url("${url}")`; sc.textContent = ""; }
  else { sc.style.backgroundImage = ""; sc.textContent = "♪"; }
}
function proxiedUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  if (rawUrl.startsWith("/")) return rawUrl;
  if (/music\.126\.net\//i.test(rawUrl)) {
    return "/proxy/audio?u=" + encodeURIComponent(rawUrl);
  }
  return rawUrl;
}

function compactTrackForState(track) {
  if (!track || (!track.title && !track.url)) return null;
  return {
    id: track.id || "",
    title: track.title || "",
    artist: track.artist || "",
    url: track.url || "",
    picUrl: track.picUrl || "",
    source: track.source || "",
    duration: track.duration || 0,
    reason: track.reason || track.pickReason || "",
    exploration: !!track.exploration,
    degraded: !!track.degraded,
  };
}

function savePlaybackStateSoon() {
  if (savePlaybackTimer) clearTimeout(savePlaybackTimer);
  savePlaybackTimer = setTimeout(() => {
    const current = compactTrackForState(currentTrack);
    fetch("/api/playback-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        started,
        paused: serverPaused,
        progressSeconds: Math.floor(music.currentTime || 0),
        currentTrack: current,
        queue: session.queue.map(compactTrackForState).filter(Boolean),
      }),
    }).catch(() => {});
  }, 700);
}

async function restorePlaybackState() {
  try {
    const r = await fetch("/api/playback-state");
    const state = await r.json();
    if (!state?.currentTrack?.url) return;
    restoredPlayback = state;
    started = !!state.started;
    serverPaused = state.paused !== false;
    session.queue = Array.isArray(state.queue) ? state.queue : [];
    setControlsActive(started);
    setNow(state.currentTrack);
    if (state.progressSeconds && Number.isFinite(state.progressSeconds)) {
      const seekTo = Math.max(0, state.progressSeconds);
      const applySeek = () => {
        try { music.currentTime = seekTo; } catch {}
      };
      if (music.readyState > 0) applySeek();
      else music.addEventListener("loadedmetadata", applySeek, { once: true });
    }
    renderQueue();
    sys("已恢复上次播放现场");
  } catch {}
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator) || !track) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title || "Uni radio",
    artist: track.artist || "",
    album: "Uni radio",
    artwork: track.picUrl ? [{ src: track.picUrl }] : [],
  });
  navigator.mediaSession.setActionHandler("play", () => send({ type: "control", action: "play" }));
  navigator.mediaSession.setActionHandler("pause", () => send({ type: "control", action: "pause" }));
  navigator.mediaSession.setActionHandler("nexttrack", () => send({ type: "feedback", action: "skip" }));
}

function syncNowTitleMarquee() {
  const el = $("np-title");
  if (!el) return;
  el.classList.remove("scrolling");
  el.style.removeProperty("--marquee-distance");
  requestAnimationFrame(() => {
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow > 12) {
      el.style.setProperty("--marquee-distance", `-${overflow + 28}px`);
      el.classList.add("scrolling");
    }
  });
}

function setNow(track) {
  // 给上一首归档（如果是自然切歌，没有显式 feedback）
  if (currentTrack && currentTrack.title && currentTrack.title !== track?.title) {
    session.played++;
    pushRecent(currentTrack, null);
    advanceSlot();
    refreshStats();
  }
  currentTrack = track;
  $("np-title").textContent = track.title || "—";
  syncNowTitleMarquee();
  $("np-artist").textContent = track.artist || "—";
  $("silent-title").textContent = track.title || "—";
  $("silent-artist").textContent = track.artist || "—";
  renderSeedBadge(track);
  setCover(track.picUrl || "");
  updateMediaSession(track);
  setLyric(null);
  if (!isActive) return;
  const playUrl = proxiedUrl(track.url);
  if (playUrl && music.src !== new URL(playUrl, location.href).href) {
    music.src = playUrl;
    applyVolumes();
    applyMusicState();
  }
  scheduleVoice(track.sayUrl, track.sayDelayMs);
  savePlaybackStateSoon();
}

function applyMusicState() {
  if (!started || !isActive) return;
  if (serverPaused) {
    if (!music.paused) music.pause();
    if (!voice.paused) voice.pause();
  } else {
    if (music.paused) music.play().catch(reportPlaybackError);
  }
  updateVinylSpin();
}

function applyRole() {
  if (isActive) {
    renderSeedBadge(currentTrack);
    $("btn-start").textContent = started ? "已开台" : "开始今日电台";
    $("btn-start").hidden = !!started;
  } else {
    music.pause(); voice.pause();
    music.removeAttribute("src"); voice.removeAttribute("src");
    $("src-badge").textContent = "静音 · 点开始接管";
    $("btn-start").textContent = "在这台播";
    $("btn-start").hidden = false;
    $("btn-start").disabled = false;
  }
  updateVinylSpin();
}

// ===== session stats =====
function refreshStats() {
  $("stat-played").textContent = session.played;
  $("stat-skipped").textContent = session.skipped;
  $("stat-chats").textContent = session.chats;
  const totalFb = session.likes + session.dislikes;
  $("stat-hit").textContent = totalFb ? Math.round(session.likes / totalFb * 100) + "%" : "—";
  // session duration
  if (session.startedAt) {
    const mins = Math.floor((Date.now() - session.startedAt) / 60000);
    $("session-duration").textContent = mins + " 分";
  }
}
function advanceSlot() { /* server 端推进，前端不再 mirror */ }
function startSession() {
  if (!session.startedAt) session.startedAt = Date.now();
  refreshStats();
}
setInterval(() => { if (session.startedAt) refreshStats(); }, 60000);

// ===== recent tracks =====
function pushRecent(track, fb) {
  if (!track || !track.title) return;
  // 跳过占位状态
  if (track.title === "Uni radio 待机" || !track.url) return;
  // 同一首不要重复推
  if (session.recent[0] && session.recent[0].title === track.title && session.recent[0].artist === track.artist) return;
  session.recent.unshift({
    title: track.title, artist: track.artist,
    picUrl: track.picUrl, fb,
  });
  if (session.recent.length > 30) session.recent.length = 30;
  renderRecent();
}
function renderRecent() {
  const ul = $("recent-list");
  if (!session.recent.length) {
    ul.innerHTML = '<li class="empty">还没播过歌</li>';
    return;
  }
  ul.innerHTML = "";
  for (const s of session.recent.slice(0, 3)) {
    const li = document.createElement("li");
    const cover = document.createElement("div");
    cover.className = "rt-cover";
    if (s.picUrl) cover.style.backgroundImage = `url("${s.picUrl}")`;
    const txt = document.createElement("div");
    txt.className = "rt-text";
    const tt = document.createElement("div"); tt.className = "rt-title"; tt.textContent = s.title || "—";
    const ar = document.createElement("div"); ar.className = "rt-artist"; ar.textContent = s.artist || "—";
    txt.appendChild(tt); txt.appendChild(ar);
    const fb = document.createElement("div");
    fb.className = "rt-fb";
    fb.textContent = s.fb === "like" ? "♡" : s.fb === "dislike" ? "⊘" : s.fb === "skip" ? "⏭" : "";
    li.appendChild(cover); li.appendChild(txt); li.appendChild(fb);
    ul.appendChild(li);
  }
}

// ===== feedback log =====
function logFeedback(action) {
  if (!currentTrack) return;
  session.feedbackLog.unshift({
    action, title: currentTrack.title, artist: currentTrack.artist, ts: Date.now(),
  });
  if (session.feedbackLog.length > 20) session.feedbackLog.length = 20;
  // 把当前曲目的反馈打到 recent 列表第一项
  if (session.recent.length && session.recent[0].title === currentTrack.title) {
    session.recent[0].fb = action;
    renderRecent();
  }
  renderFeedback();
}
function renderFeedback() {
  const ul = $("feedback-list");
  if (!session.feedbackLog.length) {
    ul.innerHTML = '<li class="empty">还没有反馈</li>';
    return;
  }
  ul.innerHTML = "";
  for (const f of session.feedbackLog.slice(0, 6)) {
    const li = document.createElement("li");
    const ic = document.createElement("span");
    ic.className = "fb-icon " + f.action;
    ic.textContent = f.action === "like" ? "♡" : f.action === "dislike" ? "⊘" : "⏭";
    const tx = document.createElement("span");
    tx.textContent = `${f.title} — ${f.artist}`;
    li.appendChild(ic); li.appendChild(tx);
    ul.appendChild(li);
  }
}

// ===== upcoming queue =====
function renderQueue() {
  const ul = $("queue-list");
  if (!ul) return;
  if (!session.queue.length && !session.queueLoading) {
    ul.innerHTML = '<li class="empty">正在等待新发现</li>';
    return;
  }
  ul.innerHTML = "";
  for (const [index, track] of session.queue.slice(0, 4).entries()) {
    const li = document.createElement("li");
    li.className = index === 0 ? "queue-next" : "queue-follow";
    const cover = document.createElement("div");
    cover.className = "rt-cover";
    if (track.picUrl) cover.style.backgroundImage = `url("${track.picUrl}")`;
    const txt = document.createElement("div");
    txt.className = "rt-text";
    const tt = document.createElement("div");
    tt.className = "rt-title";
    tt.textContent = track.title || "—";
    const ar = document.createElement("div");
    ar.className = "rt-artist";
    ar.textContent = track.artist || "—";
    const why = document.createElement("div");
    why.className = "queue-reason";
    why.textContent = track.reason || "新发现";
    txt.appendChild(tt);
    txt.appendChild(ar);
    txt.appendChild(why);
    li.appendChild(cover);
    li.appendChild(txt);
    ul.appendChild(li);
  }
  if (session.queueLoading) {
    const li = document.createElement("li");
    li.className = "queue-loading";
    li.innerHTML = "<span></span><span></span><span></span>";
    ul.appendChild(li);
  }
}

// ===== mode switch =====
function setMode(mode) {
  prefs.mode = mode;
  savePrefs();
  const isSilent = mode === "silent";
  $("stream").hidden = isSilent;
  $("silent-view").hidden = !isSilent;
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
}
document.querySelectorAll(".mode-btn").forEach((b) => {
  b.addEventListener("click", () => setMode(b.dataset.mode));
});
setMode(prefs.mode);

// ===== taste card =====
async function loadTaste() {
  try {
    const r = await fetch("/api/me/taste");
    const d = await r.json();
    const txt = (d.taste || "").trim();
    const preview = $("taste-preview");
    const expand = $("btn-taste-expand");
    if (!txt) {
      preview.textContent = "还没生成侧写。";
      expand.style.display = "none";
      return;
    }
    // 取前 200 字作为 preview
    preview.textContent = txt.slice(0, 240);
    expand.style.display = txt.length > 240 ? "" : "none";
    expand.onclick = () => {
      $("taste-modal-body").textContent = txt;
      $("taste-modal").hidden = false;
    };
  } catch (e) {
    $("taste-preview").textContent = "加载失败";
  }
}
$("taste-modal-close").addEventListener("click", () => { $("taste-modal").hidden = true; });
$("taste-modal").addEventListener("click", (e) => {
  if (e.target.id === "taste-modal") $("taste-modal").hidden = true;
});
$("btn-redraft").addEventListener("click", async () => {
  if (!confirm("重新生成听众侧写？这要 1-3 分钟，期间不影响播放。")) return;
  $("taste-preview").textContent = "正在让 Uni radio 重新认识你…";
  try {
    await fetch("/api/setup/draft", { method: "POST" });
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 4000));
      try {
        const r = await fetch("/api/setup/draft-check");
        const d = await r.json();
        if (d.status === "done") {
          // 直接覆盖
          await fetch("/api/setup/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taste: d.taste }),
          });
          loadTaste();
          sys("听众侧写已更新");
          return;
        }
        if (d.status === "error") throw new Error(d.error || "Seed 写失败");
      } catch (_) {}
    }
    throw new Error("超过 5 分钟仍未完成");
  } catch (e) {
    $("taste-preview").textContent = "重写失败：" + e.message;
  }
});

// ===== settings card =====
$("set-midsong").checked = prefs.midsong;
$("set-midsong").addEventListener("change", (e) => {
  prefs.midsong = e.target.checked;
  savePrefs();
  send({ type: "setting", key: "midsong", value: prefs.midsong });
  sys(prefs.midsong ? "已开启中段评论" : "已关闭中段评论");
});
const ttsVoiceSelect = $("set-tts-voice");
if (ttsVoiceSelect) {
  ttsVoiceSelect.value = prefs.ttsVoice;
  ttsVoiceSelect.addEventListener("change", (e) => {
    prefs.ttsVoice = e.target.value === "uni" ? "uni" : "default";
    savePrefs();
    send({ type: "setting", key: "ttsVoice", value: prefs.ttsVoice });
    sys(prefs.ttsVoice === "uni" ? "已切换到 Uni 音色" : "已切换到女声");
  });
}
$("set-theme").value = prefs.theme;
$("set-theme").addEventListener("change", (e) => {
  prefs.theme = e.target.value;
  savePrefs();
  applyTheme();
});
function applyTheme() {
  // 简易主题切换：保持黑白像素底色，只切换功能强调色。
  const root = document.documentElement;
  if (prefs.theme === "ink") {
    root.style.setProperty("--accent", "#a8d8ff");
    root.style.setProperty("--accent-soft", "rgba(168,216,255,0.12)");
    root.style.setProperty("--accent-strong", "rgba(168,216,255,0.42)");
  } else if (prefs.theme === "cover" && currentTrack?.picUrl) {
    root.style.setProperty("--accent", "#d8d8d8");
    root.style.setProperty("--accent-soft", "rgba(216,216,216,0.12)");
    root.style.setProperty("--accent-strong", "rgba(216,216,216,0.42)");
  } else {
    root.style.setProperty("--accent", "#ffffff");
    root.style.setProperty("--accent-soft", "rgba(255,255,255,0.11)");
    root.style.setProperty("--accent-strong", "rgba(255,255,255,0.42)");
  }
}
applyTheme();

// ===== chat chips =====
function renderGuide(guide) {
  const wrap = $("chat-chips");
  if (!wrap || !guide?.question || !Array.isArray(guide.options)) return;
  wrap.innerHTML = "";
  const question = document.createElement("div");
  question.className = "guide-question";
  question.textContent = guide.question;
  wrap.appendChild(question);
  for (const option of guide.options.slice(0, 4)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip guide-chip";
    button.textContent = option.label || option.text || "继续";
    button.addEventListener("click", () => {
      sendChatText(option.text || option.label);
      wrap.setAttribute("hidden", "");
    }, { once: true });
    wrap.appendChild(button);
  }
  wrap.removeAttribute("hidden");
}

document.querySelectorAll(".chip[data-chip]").forEach((c) => {
  c.addEventListener("click", () => {
    const text = c.dataset.chip;
    if (!ws || ws.readyState !== 1) return;
    sendChatText(text);
    session.chats++; refreshStats();
  });
});

// ===== WS =====
let firstWSOpen = true;
let pingTimer = null;
function startHeartbeat() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: "ping" })); } catch {}
    }
  }, 25000);
}
function stopHeartbeat() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/stream`);
  ws.onopen = () => {
    $("ws-dot").classList.add("on");
    sys("已连上 Uni radio");
    bufferedSender.setSocket(ws);
    startHeartbeat();
    send({ type: "setting", key: "midsong", value: prefs.midsong });
    if (firstWSOpen) {
      firstWSOpen = false;
      send({ type: "claim" });
      if (!restoredPlayback?.currentTrack?.url) {
        send({ type: "control", action: "reset" });
      }
    }
  };
  ws.onclose = () => {
    $("ws-dot").classList.remove("on");
    stopHeartbeat();
    sys("连接断开，3s 后重连");
    setTimeout(connectWS, 3000);
  };
  ws.onerror = () => sys("WS 错误");
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "role") {
      isActive = !!m.active;
      sys(isActive ? "拿到播放权（这台出声）" : "已转给另一端，这台静音");
      applyRole();
      if (isActive && currentTrack?.url) { music.src = proxiedUrl(currentTrack.url); applyMusicState(); }
    }
    if (m.type === "settings") {
      const voiceChoice = m.settings?.ttsVoice === "uni" ? "uni" : "default";
      prefs.ttsVoice = voiceChoice;
      savePrefs();
      if (ttsVoiceSelect) ttsVoiceSelect.value = voiceChoice;
    }
    if (m.type === "tts-voice") {
      const voiceChoice = m.value === "uni" ? "uni" : "default";
      prefs.ttsVoice = voiceChoice;
      savePrefs();
      if (ttsVoiceSelect) ttsVoiceSelect.value = voiceChoice;
    }
    if (m.type === "now") {
      setNow(m.track);
      if (!m.track?.url || m.track.title === "Uni radio 待机") hideBoot();
      // 占位状态不写进对话流
      if (m.track.title && m.track.title !== "Uni radio 待机" && m.track.url) {
        nowLine(`▶ ${m.track.title || "—"} — ${m.track.artist || "—"}`);
        pushRecent(m.track, null);
      }
      // 切歌：清空上一首遗留的 streaming 状态
      resetDjStream(m.track.id || m.track.url, "intro");
      setThinking("");
      if (m.track.title && m.track.title !== "Uni radio 待机" && m.track.url) hideBootSoon();
    }
    if (m.type === "queue") {
      session.queue = Array.isArray(m.tracks) ? m.tracks : [];
      session.queueLoading = !!m.loading;
      renderQueue();
      savePlaybackStateSoon();
      if (!session.queueLoading && (!currentTrack?.url || currentTrack.title === "Uni radio 待机")) hideBoot();
    }
    if (m.type === "dj-chunk") {
      // 新 streamId（新歌的 intro 或新一条 talk）→ 重置 bubble + 队列 + 打断旧音频
      if (m.trackId !== djStream.trackId) {
        resetDjStream(m.trackId, m.kind || "intro");
      }
      if (m.text) appendDjText(m.text);
      if (m.final) {
        djStream.finalized = true;
        finalizeDjBubble();
        if (!djStream.playing && !djStream.audioQueue.length) setDuck(false);
      }
    }
    if (m.type === "dj-chunk-audio") {
      if (m.trackId !== djStream.trackId) return;
      if (m.sayUrl) {
        warnIfVoiceMuted();
        queueDjAudio(m.idx, m.sayUrl);
      }
    }
    if (m.type === "state") { serverPaused = !!m.paused; applyMusicState(); savePlaybackStateSoon(); }
    if (m.type === "lyric") {
      if (currentTrack && (m.trackId === currentTrack.id || !currentTrack.id)) {
        setLyric(m.lines);
      }
    }
    if (m.type === "chat-ack") {
      you(m.text);
      session.chats++; refreshStats();
    }
    if (m.type === "chat-fail") sys("× " + (m.reason || "fail") + (m.error ? " — " + m.error.slice(0, 120) : ""));
    if (m.type === "guide") renderGuide(m);
    if (m.type === "dj") {
      const tag = { talk: "Uni radio · 聊天", intro: "Uni radio · 介绍", tease: "Uni radio · 预告", mid: "Uni radio · 中段" }[m.kind] || "Uni radio";
      dj(m.say, m.kind || "intro", tag);
      if (m.mood_shift) sys("情绪 → " + m.mood_shift + "（下一首会跟着调）");
      if (m.exploration) sys("✦ 这是探索性推荐");
    }
    if (m.type === "overlay") playOverlay(m.sayUrl);
    if (m.type === "tts-provider") {
      const el = $("tts-provider");
      if (el) {
        el.textContent = m.provider === "fish"
          ? `Fish voice${m.cached ? " · cache" : ""}`
          : `系统 voice${m.cached ? " · cache" : ""}`;
        el.classList.toggle("fallback", m.provider !== "fish");
      }
    }
    if (m.type === "boot-progress") {
      showBoot();
      const status = $("boot-status");
      if (status && m.msg) status.textContent = m.msg;
      setThinking(m.msg || "");
    }
    if (m.type === "boot-ready") {
      hideBootSoon();
      startBootChain(m).catch((e) => sys("boot chain 失败：" + e.message));
      startSession();
    }
    if (m.type === "boot-fail") {
      hideBoot();
      sys("× 开台失败：" + m.msg);
      setThinking("");
      $("btn-start").disabled = false;
      $("btn-start").textContent = "重试开台";
    }
    if (m.type === "queue-empty") {
      showBoot();
      setThinking("");
    }
    if (m.type === "tts-fail") sys("✗ tts: " + m.error);
    if (m.type === "feedback-ack") {
      const map = { like: "♡ 已记下：喜欢", dislike: "⊘ 已记下：不喜欢", skip: "⏭ 已跳过" };
      sys(map[m.action] || ("反馈: " + m.action));
      if (m.action === "like") session.likes++;
      else if (m.action === "dislike") session.dislikes++;
      else if (m.action === "skip") session.skipped++;
      logFeedback(m.action);
      refreshStats();
    }
    if (m.type === "claude-state") {
      const banner = document.getElementById("claude-banner");
      const msg = document.getElementById("claude-banner-msg");
      seedConnected = m.open || m.status === "unavailable" ? false
        : m.status === "unknown" ? null : true;
      renderSeedBadge();
      if (!m.open && m.status === "unavailable") return;
      if (m.status === "unknown") return;
      if (m.open) {
        seedConnected = false;
        const mins = Math.ceil((m.remainingMs || 0) / 60000);
        msg.textContent = `AI 模型暂时不可用（${m.failures || 0} 次连续失败），${mins} 分钟后自动重试。期间播音乐但没有乐评。`;
        banner.removeAttribute("hidden");
        sys("⚠ AI 模型熔断器开启");
        renderSeedBadge();
      } else {
        seedConnected = true;
        banner.setAttribute("hidden", "");
        if (m.reason === "recovered") sys("✓ Seed 已恢复连接");
        renderSeedBadge();
      }
    }
  };
}

// ===== boot overlay =====
function showBoot() {
  const ov = $("boot-overlay");
  ov.removeAttribute("hidden");
  const status = $("boot-status");
  if (status) status.textContent = "正在准备下一段音乐…";
}
function hideBoot() { $("boot-overlay").setAttribute("hidden", ""); }
function hideBootSoon() {
  setTimeout(hideBoot, 300);
}

async function startBootChain(payload) {
  if (!isActive) return;
  const { track, greetingUrl, introUrl, introText, greetingText } = payload;
  currentTrack = track;
  $("np-title").textContent = track.title || "—";
  syncNowTitleMarquee();
  $("np-artist").textContent = track.artist || "—";
  $("silent-title").textContent = track.title || "—";
  $("silent-artist").textContent = track.artist || "—";
  renderSeedBadge(track);
  setCover(track.picUrl || "");
  setLyric(null);
  pushRecent(track, null);
  music.src = proxiedUrl(track.url) || "";
  applyVolumes();
  music.pause();

  if (greetingUrl) {
    try {
      dj(greetingText || "", "intro", "Uni radio · 开场");
      voice.src = greetingUrl;
      setDuck(false);
      await voice.play();
      await new Promise((r) => voice.addEventListener("ended", r, { once: true }));
    } catch (e) { reportPlaybackError(e); }
  }

  nowLine(`▶ ${track.title} — ${track.artist}`);
  music.play().catch(reportPlaybackError);
  updateVinylSpin();
  if (introUrl) {
    try {
      voice.src = introUrl;
      setDuck(true);
      await voice.play();
    } catch (e) { reportPlaybackError(e); setDuck(false); }
    if (introText) dj(introText, "intro", "Uni radio · 介绍");
  }
}

// ===== buttons =====
function setControlsActive(on) {
  for (const id of ["btn-play", "btn-next", "btn-like", "btn-stop"]) {
    const btn = $(id);
    btn.disabled = !on;
    btn.hidden = !on;
  }
  $("btn-dislike").disabled = true;
  $("btn-dislike").hidden = true;
}
$("btn-start").addEventListener("click", () => {
  started = true;
  if (!currentTrack?.url || currentTrack.title === "Uni radio 待机") showBoot();
  setControlsActive(true);
  $("btn-start").disabled = true;
  $("btn-start").hidden = true;
  prepareVoicePlayback();
  music.play().then(() => music.pause()).catch(() => {});
  send({ type: "claim" });
  send({ type: "control", action: "start-radio" });
  startSession();
});
$("btn-play").addEventListener("click", () => send({ type: "control", action: "toggle" }));
$("btn-next").addEventListener("click", () => send({ type: "feedback", action: "skip" }));
$("btn-like").addEventListener("click", () => send({ type: "feedback", action: "like" }));
$("btn-dislike").addEventListener("click", () => send({ type: "feedback", action: "dislike" }));
$("btn-window-mode")?.addEventListener("click", toggleWindowMode);
$("btn-window-inline")?.addEventListener("click", toggleWindowMode);
$("btn-stop").addEventListener("click", () => {
  send({ type: "control", action: "reset" });
  started = false;
  setControlsActive(false);
  savePlaybackStateSoon();
  $("btn-start").disabled = false;
  $("btn-start").hidden = false;
  $("btn-start").textContent = "开始今日电台";
  setLyric(null);
  sys("已关闭电台");
});

document.getElementById("chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  sendChatText(text);
  input.value = "";
});

music.addEventListener("ended", () => {
  clearVoiceSchedule();
  setLyric(null);
  updateVinylSpin();
  if (!isActive) return;
  if (music.duration && isFinite(music.duration) && music.currentTime < music.duration - 5) {
    sys(`流提前断开：${music.currentTime.toFixed(0)}s / ${music.duration.toFixed(0)}s（可能是网易云直链被切，跳下一首）`);
    send({ type: "track-error", url: music.src, code: "premature-end", at: music.currentTime, dur: music.duration });
  } else {
    send({ type: "ended", url: music.src });
  }
});
music.addEventListener("error", () => {
  const code = music.error?.code;
  // 浏览器自动播放/网易云直链失败属于播放器内部恢复流程，不把技术错误
  // 暴露到用户对话流；保留控制台日志供排查。
  console.warn("[music] playback error", code);
  if (isActive) send({ type: "track-error", url: music.src, code });
});

// ===== volume panel (内嵌在右栏) =====
const lastVol = { music: 1.0, voice: 1.0 };

function bumpVal(el) {
  el.classList.add("bump");
  clearTimeout(el._bumpTimer);
  el._bumpTimer = setTimeout(() => el.classList.remove("bump"), 180);
}
function syncOne(target) {
  const knob = document.querySelector(`.vol-knob[data-which="${target}"]`);
  const slider = $(`vol-${target}`);
  const valEl = $(`vol-${target}-val`);
  const fill = knob.querySelector(`.vol-fill`);
  const blob = knob.querySelector(`.vol-blob`);
  const emoji = knob.querySelector(`.vol-emoji`);
  const v = target === "music" ? prefs.musicVolume : prefs.voiceVolume;
  const pct = Math.round(v * 100);
  slider.value = pct;
  valEl.textContent = pct;
  fill.style.width = pct + "%";
  blob.style.left = pct + "%";
  const muted = v === 0;
  knob.classList.toggle("muted", muted);
  emoji.textContent = "";
  emoji.setAttribute("aria-label", `${target === "music" ? "音乐" : "DJ 播报"}音量 ${pct}%`);
  emoji.title = muted ? "点击恢复音量" : "点击静音";
  if (!muted && v > 0.75) emoji.classList.add("pulsing");
  else emoji.classList.remove("pulsing");
}
function syncDuckTarget() {
  const target = Math.round(prefs.musicVolume * DUCK_FACTOR * 100);
  $("duck-target").textContent = target + "%";
}
function syncVolumeUI() {
  syncOne("music"); syncOne("voice"); syncDuckTarget();
}
syncVolumeUI();

function bindKnob(target) {
  const knob = document.querySelector(`.vol-knob[data-which="${target}"]`);
  const slider = $(`vol-${target}`);
  const emoji = knob.querySelector(".vol-emoji");
  slider.addEventListener("input", (e) => {
    const v = e.target.value / 100;
    if (target === "music") prefs.musicVolume = v; else prefs.voiceVolume = v;
    if (v > 0) lastVol[target] = v;
    applyVolumes(); savePrefs(); syncOne(target); syncDuckTarget();
    bumpVal($(`vol-${target}-val`));
  });
  slider.addEventListener("pointerdown", () => knob.classList.add("active-drag"));
  slider.addEventListener("pointerup",   () => knob.classList.remove("active-drag"));
  slider.addEventListener("pointercancel", () => knob.classList.remove("active-drag"));
  emoji.addEventListener("click", () => {
    const cur = target === "music" ? prefs.musicVolume : prefs.voiceVolume;
    if (cur > 0) {
      lastVol[target] = cur;
      if (target === "music") prefs.musicVolume = 0; else prefs.voiceVolume = 0;
    } else {
      if (target === "music") prefs.musicVolume = lastVol.music || 1;
      else prefs.voiceVolume = lastVol.voice || 1;
    }
    applyVolumes(); savePrefs(); syncOne(target); syncDuckTarget();
    bumpVal($(`vol-${target}-val`));
  });
}
bindKnob("music");
bindKnob("voice");

// ===== setup wizard =====
const setupOverlay = $("setup-overlay");
let setupQRPollTimer = null;
let setupSid = null;
let setupQRPollDelay = 4000;
let setupSmsCooldownTimer = null;

function gotoStep(name) {
  document.querySelectorAll(".setup-step").forEach((el) => {
    el.toggleAttribute("hidden", el.getAttribute("data-step") !== name);
  });
}
function showSetup(initialStep = "welcome") {
  setupOverlay.removeAttribute("hidden");
  gotoStep(initialStep);
}
function hideSetup() {
  setupOverlay.setAttribute("hidden", "");
  stopSetupBackgroundTasks();
}
function stopSetupBackgroundTasks() {
  if (setupQRPollTimer) { clearTimeout(setupQRPollTimer); setupQRPollTimer = null; }
  setupSid = null;
  if (setupSmsCooldownTimer) { clearInterval(setupSmsCooldownTimer); setupSmsCooldownTimer = null; }
}
function setupError(msg) {
  $("setup-error-msg").textContent = msg || "未知错误";
  gotoStep("error");
}

function renderQrDebug(debug) {
  const el = $("setup-qr-debug");
  if (!el) return;
  if (!debug) {
    el.textContent = "";
    return;
  }
  const chainId = debug.chainId ? debug.chainId.slice(0, 22) + "..." : "no-chain";
  const err = debug.lastError ? ` · ${debug.lastError.slice(0, 36)}` : "";
  el.textContent = `QR ${debug.code || "-"} / ${debug.status || "-"} · ${debug.polls || 0} 次 · ${chainId}${err}`;
}

async function fetchJSON(input, init) {
  const r = await fetch(input, init);
  const txt = await r.text();
  if (!txt || txt[0] === "<") {
    throw new Error("链接暂时连不上，可能主人电脑或网络抖了一下，过几分钟再试或找主人");
  }
  let d;
  try { d = JSON.parse(txt); } catch { throw new Error("服务器返回异常"); }
  return { ok: r.ok, status: r.status, data: d };
}

async function setupStartQR() {
  if (setupQRPollTimer) {
    clearTimeout(setupQRPollTimer);
    setupQRPollTimer = null;
  }
  gotoStep("qr");
  $("setup-qr-img").innerHTML = "生成中…";
  $("setup-qr-status").textContent = "等待扫码…";
  $("setup-qr-status").className = "setup-status";
  renderQrDebug(null);
  setupQRPollDelay = 4000;
  try {
    const { ok, data: d } = await fetchJSON("/api/setup/qr-start", { method: "POST" });
    if (!ok) throw new Error(d.error || "qr-start 失败");
    setupSid = d.sid;
    if (d.qrimg) {
      $("setup-qr-img").innerHTML = `<img alt="QR" src="${d.qrimg}" />`;
    } else if (d.qrurl) {
      $("setup-qr-img").innerHTML =
        `<img alt="QR" src="https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(d.qrurl)}" />`;
    } else {
      $("setup-qr-img").innerHTML = "二维码数据缺失";
    }
    renderQrDebug(d.debug);
    setupQRPollTimer = setTimeout(setupPollQR, setupQRPollDelay);
  } catch (e) {
    setupError("无法生成二维码：" + e.message);
  }
}

async function setupPollQR() {
  if (!setupSid) return;
  try {
    const { ok, data: d } = await fetchJSON("/api/setup/qr-check?sid=" + setupSid);
    renderQrDebug(d.debug);
    if (!ok) {
      clearTimeout(setupQRPollTimer); setupQRPollTimer = null;
      setupError(d.error || "扫码状态获取失败"); return;
    }
    if (d.status === "scanned") {
      $("setup-qr-status").textContent = "扫到了，请快在手机上点「确认登录」";
      $("setup-qr-status").className = "setup-status scanned";
      setupQRPollDelay = 6000;
    } else if (d.status === "expired") {
      clearTimeout(setupQRPollTimer); setupQRPollTimer = null;
      setupSid = null;
      $("setup-qr-img").innerHTML = `<button class="setup-secondary" type="button" id="setup-qr-refresh">重新生成二维码</button>`;
      $("setup-qr-refresh").addEventListener("click", setupStartQR, { once: true });
      $("setup-qr-status").textContent = "二维码过期了，点上面按钮重新生成";
      $("setup-qr-status").className = "setup-status";
      return;
    } else if (d.status === "done") {
      clearTimeout(setupQRPollTimer); setupQRPollTimer = null;
      $("setup-qr-status").textContent = `登录成功：${d.profile?.nickname || ""}`;
      setupRunImport();
      return;
    } else {
      if ($("setup-qr-status").className !== "setup-status scanned") {
        $("setup-qr-status").textContent = "等待扫码…";
      }
    }
  } catch (e) {}
  setupQRPollTimer = setTimeout(setupPollQR, setupQRPollDelay);
}

async function setupCookieLogin() {
  stopSetupBackgroundTasks();
  const cookie = $("setup-cookie").value.trim();
  if (!cookie) {
    alert("请粘贴包含 MUSIC_U 的 Cookie");
    return;
  }
  gotoStep("import");
  $("setup-import-msg").textContent = "正在验证 Cookie…";
  try {
    const { ok, data: d } = await fetchJSON("/api/setup/cookie-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie }),
    });
    if (!ok) throw new Error(d.error || "Cookie 验证失败");
    $("setup-import-msg").textContent = `登录成功：${d.profile?.nickname || ""}。开始读取歌单…`;
    setupRunImport();
  } catch (e) {
    setupError("Cookie 登录失败：" + e.message);
  }
}

function getSmsPayload() {
  return {
    phone: $("setup-sms-phone").value.trim(),
    ctcode: $("setup-sms-ctcode").value.trim() || "86",
    captcha: $("setup-sms-code").value.trim(),
  };
}

function setSmsStatus(text, kind = "") {
  const el = $("setup-sms-status");
  el.textContent = text || "";
  el.className = "setup-status" + (kind ? " " + kind : "");
}

function startSmsCooldown(seconds = 60) {
  const btn = $("setup-sms-send");
  let left = seconds;
  btn.disabled = true;
  btn.textContent = `${left}s 后重发`;
  if (setupSmsCooldownTimer) clearInterval(setupSmsCooldownTimer);
  setupSmsCooldownTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(setupSmsCooldownTimer);
      setupSmsCooldownTimer = null;
      btn.disabled = false;
      btn.textContent = "发送验证码";
      return;
    }
    btn.textContent = `${left}s 后重发`;
  }, 1000);
}

async function setupSmsSend() {
  const payload = getSmsPayload();
  if (!payload.phone) {
    alert("请输入网易云绑定手机号");
    return;
  }
  setSmsStatus("正在发送验证码…");
  try {
    const { ok, data: d } = await fetchJSON("/api/setup/sms-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!ok) throw new Error(d.error || "验证码发送失败");
    setSmsStatus("验证码已发送，收到后填进来。", "scanned");
    startSmsCooldown(60);
    $("setup-sms-code").focus();
  } catch (e) {
    setSmsStatus("发送失败：" + e.message, "error");
  }
}

async function setupSmsLogin() {
  stopSetupBackgroundTasks();
  const payload = getSmsPayload();
  if (!payload.phone || !payload.captcha) {
    alert("请输入手机号和短信验证码");
    return;
  }
  gotoStep("import");
  $("setup-import-msg").textContent = "正在验证短信登录…";
  try {
    const { ok, data: d } = await fetchJSON("/api/setup/sms-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!ok) throw new Error(d.error || "短信登录失败");
    $("setup-import-msg").textContent = `登录成功：${d.profile?.nickname || ""}。开始读取歌单…`;
    setupRunImport();
  } catch (e) {
    setupError("短信登录失败：" + e.message);
  }
}

async function setupPublicImport() {
  stopSetupBackgroundTasks();
  const uid = $("setup-public-uid").value.trim();
  if (!uid) {
    alert("请粘贴网易云个人主页链接，或输入用户 ID");
    return;
  }
  gotoStep("import");
  $("setup-import-msg").textContent = "正在读取公开歌单…";
  try {
    const { ok, data: d } = await fetchJSON("/api/setup/public-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid }),
    });
    if (!ok) throw new Error(d.error || "公开歌单导入失败");
    $("setup-import-msg").textContent =
      `${d.nickname}：${d.created} 个公开自建歌单 / ${d.subscribed || 0} 个收藏歌单。下一步让 Uni radio 读一下…`;
    setTimeout(setupRunDraft, 800);
  } catch (e) {
    setupError("公开歌单导入失败：" + e.message);
  }
}

async function setupRunImport() {
  gotoStep("import");
  try {
    const { ok, data: d } = await fetchJSON("/api/setup/import", { method: "POST" });
    if (!ok) throw new Error(d.error || "导入失败");
    $("setup-import-msg").textContent =
      `${d.nickname}：${d.created} 个自建歌单 / ${d.week} 首周榜 / ${d.allTime} 首总榜。下一步让 Uni radio 读一下…`;
    setTimeout(setupRunDraft, 800);
  } catch (e) {
    setupError("导入失败：" + e.message);
  }
}

async function setupRunDraft() {
  gotoStep("drafting");
  try {
    const { ok, data: sd } = await fetchJSON("/api/setup/draft", { method: "POST" });
    if (!ok) throw new Error(sd.error || "启动 draft 失败");
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const { data: d } = await fetchJSON("/api/setup/draft-check");
        if (d.status === "done") {
          $("setup-taste").value = d.taste;
          gotoStep("review");
          return;
        }
        if (d.status === "error") throw new Error(d.error || "Seed 写失败");
      } catch (e) {}
    }
    throw new Error("超过 5 分钟仍未完成");
  } catch (e) {
    setupError("AI 写侧写失败：" + e.message + "（Seed 服务可能暂时不可用，过会再试）");
  }
}

async function setupSave() {
  const taste = $("setup-taste").value.trim();
  if (!taste) { alert("内容不能空"); return; }
  try {
    const { ok, data: d } = await fetchJSON("/api/setup/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taste }),
    });
    if (!ok) throw new Error(d.error || "保存失败");
    stopSetupBackgroundTasks();
    gotoStep("done");
  } catch (e) {
    setupError("保存失败：" + e.message);
  }
}

document.querySelectorAll("[data-go]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const go = btn.getAttribute("data-go");
    if (go === "welcome") gotoStep("welcome");
    else if (go === "qr") setupStartQR();
    else if (go === "sms") { setSmsStatus(""); gotoStep("sms"); }
    else if (go === "sms-send") setupSmsSend();
    else if (go === "sms-login") setupSmsLogin();
    else if (go === "public") gotoStep("public");
    else if (go === "public-import") setupPublicImport();
    else if (go === "cookie") gotoStep("cookie");
    else if (go === "cookie-login") setupCookieLogin();
    else if (go === "drafting") setupRunDraft();
    else if (go === "save") setupSave();
    else if (go === "finish") {
      hideSetup();
      loadTaste();
      started = true;
      setControlsActive(true);
      $("btn-start").disabled = true;
      $("btn-start").hidden = true;
      prepareVoicePlayback();
      send({ type: "claim" });
      send({ type: "control", action: "start-radio" });
      startSession();
    }
  });
});

async function checkSetupOnLoad() {
  try {
    const r = await fetch("/api/setup/status");
    const d = await r.json();
    if (d.hasSetup) {
      loadTaste();
      return;
    }
    if (d.hasPlaylists) {
      sys("检测到上次设置没完成，正在重新生成你的侧写…");
      showSetup("drafting");
      setupRunDraft();
    } else {
      showSetup("welcome");
    }
  } catch {}
}
checkSetupOnLoad();

// 初始渲染
refreshStats();
renderRecent();
renderFeedback();
renderQueue();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations?.().then((regs) => {
    for (const reg of regs) reg.unregister().catch(() => {});
  }).catch(() => {});
}

restorePlaybackState().finally(connectWS);
