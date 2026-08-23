import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("database seed never fabricates a public solver spot", async () => {
  const seed = await readFile(new URL("../prisma/seed.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(seed, /development-default-spot|publicPayload|privateSolutionPayload/);
  assert.match(seed, /added no solver content/);
});
