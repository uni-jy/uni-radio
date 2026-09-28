import test from "node:test";
import assert from "node:assert/strict";
import { Tenant } from "../server/tenant.js";

test("reset invalidates the old worker and releases the slot for a new request", () => {
  const tenant = { prefetchToken: 7, prefetching: true, queue: [{ title: "old" }] };
  const oldWorkerToken = tenant.prefetchToken;
  Tenant.prototype.invalidatePrefetch.call(tenant);
  assert.notEqual(tenant.prefetchToken, oldWorkerToken);
  assert.equal(tenant.prefetching, false);
  assert.deepEqual(tenant.queue, []);
});
