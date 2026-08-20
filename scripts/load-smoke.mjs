const base = process.env.LOAD_BASE_URL ?? "http://127.0.0.1:3000";
const path = process.env.LOAD_PATH ?? "/health/live";
const total = Number(process.env.LOAD_REQUESTS ?? 100);
const concurrency = Math.max(1, Number(process.env.LOAD_CONCURRENCY ?? 10));
if (!Number.isInteger(total) || total < 1 || total > 10_000) throw new Error("LOAD_REQUESTS must be an integer from 1 to 10000");
const started = performance.now();
let next = 0;
let failures = 0;
async function worker() {
  while (true) {
    const index = next++;
    if (index >= total) return;
    try {
      const response = await fetch(new URL(path, base));
      if (!response.ok) failures += 1;
      await response.arrayBuffer();
    } catch { failures += 1; }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
const elapsedMs = performance.now() - started;
const throughput = (total / elapsedMs) * 1000;
console.log(JSON.stringify({ base, path, requests: total, concurrency, failures, elapsedMs: Math.round(elapsedMs), requestsPerSecond: Number(throughput.toFixed(2)) }));
if (failures) process.exitCode = 1;
