# Uni radio · 个人 AI 电台 — 规划文档

> 一句话：读懂我的听歌习惯 → 规划当下该听的声音 → 像 DJ 那样播报出来。
> 形态：本地 PWA + Node 中枢 + Seed 2.1 Pro API 做"大脑"。通过 OpenAI-compatible 接口调用。

---

## 0. 设计原则

1. **本地优先**：除歌曲流和模型推理外，所有状态、缓存、用户语料都落本地文件（便于备份、可读、可手改）。
2. **模型即大脑，API 是稳定边界**：通过 OpenAI-compatible chat completions 调用 Seed 2.1 Pro，统一处理超时、流式输出和熔断。
3. **小盒子拼装 prompt**：每次触发都把 6 类碎片（系统词 / 用户语料 / 环境 / 已检索记忆 / 输入 / 执行轨迹）拼成 system prompt，便于审计和回放。
4. **声音是一等公民**：DJ 播报先合成、再缓存、再播放；播报与音乐之间的衔接（segue）由模型显式给出。
5. **可中断、可改写**：用户随时插话（自然语言走 router → Seed；明确指令直连 ncm）。

---

## 1. 四层架构（与施工图一一对应）

### 第一层 · 外部上下文（喂养层）

| 模块 | 作用 | 关键文件 / 端点 |
|---|---|---|
| **USER** 用户品味语料 | 让 Uni radio 真正属于"我" | `user/taste.md`、`user/routines.md`、`user/playlists.json`、`user/mood-rules.md` |
| **BRAIN** Seed 2.1 Pro | OpenAI-compatible HTTP 调用 | `SEED_BASE_URL` + `SEED_MODEL` |
| **MUSIC** NeteaseCloudMusicApi | 歌曲检索 / 直链 / 歌词 / 推荐 | `search`、`song_url`、`lyric`、`recommend` |
| **VOICE & I/O** | 声音、日程、天气、客厅 | Fish Audio TTS、飞书 (Lark) 日历、OpenWeather、UPnP (Naim) |

> 这一层的关键产物是 **"我是谁"的可读文档**。`taste.md` 不是 JSON 而是自然语言段落，比如"夜里 11 点后我厌恶突然变响的歌"——模型才能用得上。

### 第二层 · 本地大脑（聚合 + 调度）

| 模块 | 职责 |
|---|---|
| `router.js` | 意图分流：简单指令直连 ncm；"换个温柔点的"自然语言走 Seed |
| `context.js` | 提示词组装：taste + routines + 环境 + 历史 → system prompt |
| `claude.js` | LLM 适配器：调用 Seed chat completions、流式读取、解析 `{say, play[], reason, segue}` |
| `scheduler.js` | 节律调度：07:00 规划 / 09:00 早间 / 小时情绪检查 / 日历 hook |
| `tts.js` | 声音管线：Fish Audio → `cache/tts/<hash>.mp3` |
| `state.db` | 状态 + 记忆：`messages` `plays` `plan` `prefs`（SQLite，可跨重启） |

### 第三层 · 运行时聚合（Context Window）

每次触发把这 6 片粘成 prompt：

1. **系统提示词** — `prompts/dj-persona.md`（DJ 人设 + 输出 schema）
2. **用户语料** — `user/*.md`
3. **环境注入** — weather / calendar / now
4. **已检索记忆** — `state.db` 里的 `plays` 最近 N 条 + 同时段历史
5. **用户输入 / 工具结果** — `/api/chat` body、ncm search 结果
6. **执行轨迹** — scheduler 触发原因、webhook 来源

**模型前向过程**：`compute(fragments) → {say, play[], reason, segue}` → ncm 解析 queue → tts 合成 say → WebSocket 推 now-playing 给前端。

### 第四层 · 交互表层

- **PWA**（`localhost:8080`）：Player / Profile / Settings 三视图、单 `<audio>` 标签接力、WS 流式聊天、Service Worker 壳层缓存、prefetch 下一首 10 秒。
- **HTTP 合同（PWA ↔ server 的 6 条线）**：
  - `POST /api/chat` — 自由对话 / 自然语言指令
  - `GET /api/now` — 当前在播
  - `GET /api/next` — 下一首
  - `GET /api/taste` — 读 / 回写品味语料
  - `GET /api/plan/today` — 今日节目单
  - `WS /stream` — now-playing、播报字幕、状态推送

---

## 2. 目录结构

```
unico/
├── PLAN.md                  ← 本文件
├── README.md
├── package.json
├── .env.example
├── server/
│   ├── index.js             # 入口、HTTP + WS
│   ├── router.js            # 意图分流
│   ├── context.js           # prompt 组装
│   ├── claude.js            # claude -p 适配器
│   ├── scheduler.js         # cron 节律
│   ├── tts.js               # Fish Audio 管线
│   ├── state.js             # SQLite 封装
│   ├── adapters/
│   │   ├── ncm.js           # NeteaseCloudMusicApi 客户端
│   │   ├── lark.js          # 飞书日历
│   │   ├── weather.js       # OpenWeather
│   │   └── upnp.js          # Naim / DLNA 推流
│   └── prompts/
│       ├── dj-persona.md
│       ├── planner.md
│       └── schema.json      # 模型输出 JSON schema
├── user/                    # 用户语料（自己写、模型读、偶尔回写）
│   ├── taste.md
│   ├── routines.md
│   ├── playlists.json
│   └── mood-rules.md
├── cache/
│   └── tts/                 # <hash>.mp3
├── data/
│   └── state.db             # SQLite
├── pwa/
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── sw.js
│   └── src/
│       ├── player.js
│       ├── profile.js
│       ├── settings.js
│       └── ws.js
└── scripts/
    ├── dev.sh
    └── seed-taste.js        # 从历史播放生成初始 taste.md
```

---

## 3. 数据模型（state.db）

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  ts INTEGER, role TEXT, content TEXT, meta JSON
);
CREATE TABLE plays (
  id INTEGER PRIMARY KEY,
  ts INTEGER, song_id TEXT, title TEXT, artist TEXT,
  source TEXT,            -- 'plan' | 'chat' | 'manual'
  reason TEXT,            -- 模型给的理由
  liked INTEGER           -- 1/0/-1，反馈闭环用
);
CREATE TABLE plan (
  date TEXT PRIMARY KEY,  -- YYYY-MM-DD
  json TEXT               -- 当日节目单
);
CREATE TABLE prefs (
  key TEXT PRIMARY KEY, value TEXT
);
```

---

## 4. 模型输出 schema（关键约束）

```jsonc
{
  "say": "string，DJ 播报原文，2-4 句，会被 TTS",
  "play": [
    { "query": "歌名 - 歌手", "reason": "为什么这首" }
  ],
  "reason": "整段决策的一句话总结",
  "segue": "string，播报到音乐的过渡方式：fade | hard | talk-over-intro"
}
```

> 模型只产出"想播什么"，**真实曲目解析交给 router → ncm**。这样模型幻觉了一首不存在的歌也不会崩。

---

## 5. 关键触发链（端到端走一遍）

**场景**：周六上午 9:00，自动早间节目。

1. `scheduler.js` 触发 `morning` 事件 → 调 `context.build('morning')`
2. `context.js` 拼接：dj-persona + taste.md + 今天日历（飞书）+ 当前天气 + 近 48h `plays` + 今日 plan
3. `claude.js` 调用 Seed chat completions，流式拿 JSON
4. 解析 `play[]` → `ncm.search()` 每首拿到 `song_id` → `song_url()` 拿直链 → 入队 `queue`
5. `tts.js` 把 `say` 喂 Fish Audio → `cache/tts/<hash>.mp3`
6. WS 推 `{type:'cue', say_url, songs:[...]}` 给 PWA
7. PWA 单 `<audio>` 接力：先播 `say_url`，结束事件触发播第一首；`segue=fade` 时做 1.5s 交叉淡入
8. 用户点"跳过" → `POST /api/chat {intent:'skip', reason?}` → 走 router → 必要时回 Seed 要替补
9. 每首结束写 `plays`，每日 23:50 跑一遍"taste.md 增量回写"小任务（模型读 plays，提议追加段落，需用户确认）

---

## 6. 里程碑（建议 5 个 PR / 5 天节奏）

| # | 目标 | 验收 |
|---|---|---|
| M1 | 骨架：Node server + PWA 壳 + 一条 WS + 一首本地 mp3 能播 | 浏览器打开 `localhost:8080`，点播放出声 |
| M2 | 接通 ncm：搜歌 / 拿直链 / 真曲目能播 | 在 chat 框输入"放周杰伦"出歌 |
| M3 | 接通 Seed：chat completions 跑通，输出 schema 解析正确 | "放点适合现在的"能拿到 `{say, play[]}` |
| M4 | 接通 TTS + 节律：Fish Audio 合成 say，9 点早间自动触发 | 每天 9 点出一段"早安 + 三首歌" |
| M5 | 反馈闭环 + UPnP + 飞书：跳过 / 喜欢回写 taste、可推到 Naim | 一周用下来，taste.md 自然变厚 |

---

## 7. 风险与回避

- **Seed API 延迟或抖动** → 使用超时、熔断和流式输出降低等待；TTS 结果进入本地缓存
- **ncm 直链失效 / 灰名单** → 每次播放前 HEAD 校验，失败自动换备播
- **TTS 配额 / 网络抖** → `cache/tts/<hash>.mp3` 永久缓存；同句不重合成
- **模型乱编歌名** → 强约束输出 schema；ncm 找不到时把"找不到的歌名"反喂给模型让它换
- **PWA `<audio>` 自动播放策略** → 首次进入需用户点一次"开始今日电台"以解锁

---

## 8. 下一步

确认本文档后，我会：

1. 初始化仓库骨架（`package.json` / 目录 / `.env.example` / `dev.sh`）
2. 写 M1 最小可跑版本（Node + 一条 WS + PWA 壳 + 一首本地 mp3）
3. 然后按 M2 → M5 推进，每个里程碑独立可演示
