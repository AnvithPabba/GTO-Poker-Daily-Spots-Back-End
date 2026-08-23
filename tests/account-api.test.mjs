import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { createPublicApiRouter } from "../dist/api.js";
import { FakeIdentityProvider } from "../dist/ports.js";
import { PublicApplicationService } from "../dist/application/public-api.js";

const databaseUrl = process.env.DATABASE_URL;

test("OIDC principal owns /users/me statistics and history independently of guest cookies", { skip: !databaseUrl && "DATABASE_URL is not set" }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const subject = `account-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let server;
  try {
    const app = express();
    app.use("/api/v1", createPublicApiRouter({ application: new PublicApplicationService(prisma), prisma, guestCookieHashSecret: "account-test-secret", guestCookieName: "account_guest", secureCookies: false, identityProvider: new FakeIdentityProvider({ subject, email: "test@example.invalid", roles: ["user"] }) }));
    server = createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const stats = await fetch(`${base}/api/v1/users/me/stats`, { headers: { authorization: "Bearer fake", cookie: "account_guest=ignored_guest_cookie_value_123456789" } });
    assert.equal(stats.status, 200);
    assert.equal((await stats.json()).spotsCompleted, 0);
    const account = await prisma.account.findUnique({ where: { subject } });
    assert.equal(account.email, "test@example.invalid");
    assert.deepEqual(account.roles, ["user"]);
    const history = await fetch(`${base}/api/v1/users/me/attempts`, { headers: { authorization: "Bearer fake" } });
    assert.deepEqual(await history.json(), { attempts: [] });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await prisma.account.deleteMany({ where: { subject } });
    await prisma.$disconnect();
  }
});
