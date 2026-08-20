import type { Request } from "express";

export type Principal = { subject: string; email?: string; roles: string[] };

export interface SpotRepository<TSpot = unknown> {
  getDailySpots(date: string): Promise<TSpot[]>;
  getById(id: string): Promise<TSpot | null>;
}

export interface IdentityProvider {
  verify(request: Request): Promise<Principal | null>;
}

export interface ArchiveStore {
  put(key: string, content: Uint8Array, checksum: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<{ checksum: string; size: number }>;
}

export interface CacheStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  invalidate(key: string): Promise<void>;
}

export interface Clock { now(): Date; }

export class SystemClock implements Clock { public now(): Date { return new Date(); } }

export class FakeIdentityProvider implements IdentityProvider {
  public constructor(private readonly principal: Principal | null = null) {}
  public async verify(): Promise<Principal | null> { return this.principal; }
}

export class InMemoryCacheStore implements CacheStore {
  private readonly values = new Map<string, { value: unknown; expiresAt: number }>();
  public async get(key: string): Promise<unknown | undefined> { const entry = this.values.get(key); if (!entry || entry.expiresAt <= Date.now()) { this.values.delete(key); return undefined; } return entry.value; }
  public async set(key: string, value: unknown, ttlSeconds: number): Promise<void> { this.values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 }); }
  public async invalidate(key: string): Promise<void> { this.values.delete(key); }
}
