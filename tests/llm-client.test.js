import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChatRequest,
  getLLMConfig,
  parseChatCompletion,
  parseSSEDelta,
  streamChat,
} from "../server/llm-client.js";

test("getLLMConfig defaults to Seed 2.1 Pro", () => {
  assert.deepEqual(getLLMConfig({}), {
    apiKey: "",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-1-pro-260915",
  });
});

test("getLLMConfig prefers Seed env", () => {
  const env = {
    SEED_API_KEY: "seed-key",
    SEED_BASE_URL: "https://ark.example/api/v3",
    SEED_MODEL: "doubao-seed-2-1-pro-260915",
  };
  assert.deepEqual(getLLMConfig(env), {
    apiKey: "seed-key",
    baseUrl: "https://ark.example/api/v3",
    model: "doubao-seed-2-1-pro-260915",
  });
});

test("getLLMConfig keeps DeepSeek as a backward-compatible fallback", () => {
  const env = {
    DEEPSEEK_API_KEY: "ds-key",
    DEEPSEEK_BASE_URL: "https://relay.example/v1",
    UNICO_MODEL: "deepseek-v4-pro",
  };
  assert.deepEqual(getLLMConfig(env), {
    apiKey: "ds-key",
    baseUrl: "https://relay.example/v1",
    model: "deepseek-v4-pro",
  });
});

test("getLLMConfig accepts OpenAI-compatible fallback env", () => {
  const env = {
    OPENAI_API_KEY: "openai-compatible-key",
    OPENAI_BASE_URL: "https://openai-compatible.example/v1/",
    UNICO_MODEL: "deepseek-v4-pro",
  };
  assert.deepEqual(getLLMConfig(env), {
    apiKey: "openai-compatible-key",
    baseUrl: "https://openai-compatible.example/v1",
    model: "deepseek-v4-pro",
  });
});

test("buildChatRequest creates OpenAI-compatible chat completion request", () => {
  const req = buildChatRequest({
    system: "system text",
    user: "user text",
    stream: false,
    config: { apiKey: "key", baseUrl: "https://relay.example/v1", model: "deepseek-v4-pro" },
  });
  assert.equal(req.url, "https://relay.example/v1/chat/completions");
  assert.equal(req.options.method, "POST");
  assert.equal(req.options.headers.Authorization, "Bearer key");
  assert.equal(req.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(req.options.body), {
    model: "deepseek-v4-pro",
    messages: [
      { role: "system", content: "system text" },
      { role: "user", content: "user text" },
    ],
    stream: false,
    temperature: 0.8,
  });
});

test("parseChatCompletion returns assistant content", () => {
  const text = parseChatCompletion({
    choices: [{ message: { content: "{\"ok\":true}" } }],
  });
  assert.equal(text, "{\"ok\":true}");
});

test("Seed realtime requests disable thinking by default", () => {
  const previous = process.env.SEED_THINKING;
  delete process.env.SEED_THINKING;
  try {
    const req = buildChatRequest({ config: { apiKey: "test", baseUrl: "https://example.test", model: "doubao-seed-2-1-pro-260915" } });
    assert.deepEqual(JSON.parse(req.options.body).thinking, { type: "disabled" });
  } finally {
    if (previous !== undefined) process.env.SEED_THINKING = previous;
  }
});

test("parseSSEDelta extracts streaming content deltas", () => {
  const chunks = parseSSEDelta([
    "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}",
    "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}",
    "data: [DONE]",
  ].join("\n\n"));
  assert.deepEqual(chunks, ["你", "好"]);
});

test("streamChat preserves SSE events and Chinese text across network boundaries", async () => {
  const previous = process.env.SEED_API_KEY;
  process.env.SEED_API_KEY = "test-only";
  try {
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":"，音乐"}}]}');
    const deltas = [];
    const result = await streamChat({
      user: "test", onDelta: part => deltas.push(part),
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      })),
    });
    assert.equal(result, "你好，音乐");
    assert.deepEqual(deltas, ["你好", "，音乐"]);
  } finally {
    if (previous === undefined) delete process.env.SEED_API_KEY;
    else process.env.SEED_API_KEY = previous;
  }
});
