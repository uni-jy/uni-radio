// 必须作为 server/index.js 的第一个 import —— 在 ncm/axios 等模块加载前清理代理 env
import fs from "node:fs";

if (fs.existsSync(".env")) {
  process.loadEnvFile?.(".env");
}
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"]) {
  delete process.env[k];
}
// Uni radio 默认使用火山引擎 Seed 2.1 Pro，也兼容 OpenAI/Anthropic-compatible 配置。
// 只有显式使用 Claude 模型且未声明 UNICO_USE_API_KEY 时，才清理这些变量走 OAuth。
const model = process.env.SEED_MODEL || process.env.UNICO_MODEL || "doubao-seed-2-1-pro-260915";
const shouldForceOAuth = /^claude/i.test(model) && !process.env.UNICO_USE_API_KEY;
if (shouldForceOAuth) {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("[env] 已忽略 ANTHROPIC_API_KEY（强制 claude CLI 走 OAuth Max）");
    delete process.env.ANTHROPIC_API_KEY;
  }
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
}
