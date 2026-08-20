import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createPublicApiRouter } from "../dist/api.js";
import { FakeIdentityProvider } from "../dist/ports.js";

const databaseUrl = process.env.DATABASE_URL;

test("OIDC account history is isolated from guest history and upserts by subject", { skip: !databaseUrl && "DATABASE_URL is not set" }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const subject = `account-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let server;
  try {
    const app = express();
    app.use("/api/v1", createPublicApiRouter({ prisma, guestCookieHashSecret: "account-test-secret", guestCookieName: "account_guest", secureCookies: false, identityProvider: new FakeIdentityProvider({ subject, email: "test@example.invalid", roles: ["user"] }) }));
    server = createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const me = await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: "Bearer fake" } });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { subject, email: "test@example.invalid", roles: ["user"], accountId: (await prisma.account.findUnique({ where: { subject }, select: { id: true } })).id });
    const history = await fetch(`${base}/api/v1/auth/history`, { headers: { authorization: "Bearer fake" } });
    assert.deepEqual(await history.json(), { attempts: [] });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await prisma.account.deleteMany({ where: { subject } });
    await prisma.$disconnect();
  }
});
