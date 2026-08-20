#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const roots = process.argv.slice(2);
const extensions = new Set([".ts", ".tsx", ".mjs", ".json"]);
const failures = [];

async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!new Set(["node_modules", "dist", "coverage"]).has(entry.name)) await walk(path);
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (!extensions.has(extension)) continue;
    const text = await readFile(path, "utf8");
    if (/[ \t]+$/m.test(text)) failures.push(`${relative(process.cwd(), path)}: trailing whitespace`);
    if (text.includes("\r\n")) failures.push(`${relative(process.cwd(), path)}: CRLF line endings`);
  }
}

for (const root of roots) await walk(root);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`lint ok: ${roots.join(", ")}`);
}
