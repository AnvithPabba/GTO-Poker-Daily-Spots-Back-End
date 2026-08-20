import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import test from "node:test";

import { createPublicApiRouter } from "../dist/api.js";

test("attempt submissions are rate limited per client without requiring a database lookup", async () => {
  const app = express();
  app.use("/api/v1", createPublicApiRouter({
    prisma: { spot: { findFirst: async () => null } },
    guestCookieHashSecret: "rate-limit-test-secret",
    guestCookieName: "rate_limit_guest",
    secureCookies: false,
  }));
  const server = createServer(app);
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const statuses = [];
    for (let index = 0; index < 61; index += 1) {
      statuses.push((await fetch(`${base}/api/v1/spots/missing/attempts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status);
    }
    assert.equal(statuses.slice(0, 60).every((status) => status === 404), true);
    assert.equal(statuses[60], 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
