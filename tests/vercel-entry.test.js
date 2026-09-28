import test from "node:test";
import assert from "node:assert/strict";

test("Vercel entry exports the Uni radio HTTP server with WebSocket support", async () => {
  process.env.UNICO_AUTOSTART = "0";
  const mod = await import("../api/index.js");
  const server = mod.default;

  assert.equal(typeof server?.listen, "function");
  assert.equal(typeof server?.emit, "function");
  assert.ok(server.listeners("upgrade").length > 0);
});
