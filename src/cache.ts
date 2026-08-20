import type { CacheStore } from "./ports.js";

export class NoopCacheStore implements CacheStore {
  public async get(): Promise<unknown | undefined> { return undefined; }
  public async set(): Promise<void> {}
  public async invalidate(): Promise<void> {}
}

export async function cached<T>(cache: CacheStore, key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  const hit = await cache.get(key);
  if (hit !== undefined) return hit as T;
  const value = await loader();
  await cache.set(key, value, ttlSeconds);
  return value;
}
