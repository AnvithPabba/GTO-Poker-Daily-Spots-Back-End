import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";

const validEnvironment = {
  DATABASE_URL: "postgresql://trainer_api:password@postgres:5432/poker_trainer_dev",
};

test("environment validation applies safe development defaults", () => {
  assert.deepEqual(loadConfig(validEnvironment), {
    API_HOST: "0.0.0.0",
    API_PORT: 3000,
    CORS_ORIGIN: "http://localhost:4173",
    DATABASE_URL: validEnvironment.DATABASE_URL,
    ADMIN_TRUSTED_PROXY: false,
    GUEST_COOKIE_HASH_SECRET: "local-development-guest-cookie-secret",
    GUEST_COOKIE_NAME: "poker_guest",
    NODE_ENV: "development",
    PG_BOSS_SCHEMA: "pgboss",
    WORKER_HOST: "0.0.0.0",
    WORKER_PORT: 3001,
  });
});

test("environment validation rejects a missing database URL", () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
});

test("environment validation parses the trusted admin proxy flag", () => {
  const config = loadConfig({ DATABASE_URL: "postgresql://localhost/test", ADMIN_TRUSTED_PROXY: "true" });
  assert.equal(config.ADMIN_TRUSTED_PROXY, true);
});
