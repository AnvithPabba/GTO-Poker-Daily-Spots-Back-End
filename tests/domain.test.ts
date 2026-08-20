import { describe, expect, it } from "vitest";
import { FakeIdentityProvider, InMemoryCacheStore } from "../src/ports.js";
import { InMemorySpotRepository } from "../src/repositories.js";
import { cached } from "../src/cache.js";
import { requireRole } from "../src/auth.js";
import { AppError } from "../src/errors.js";
import { l1Metric, scoreHands } from "../src/scoring.js";
import { OidcIdentityProvider } from "../src/oidc.js";
import { isLoopbackRequest } from "../src/admin.js";
import { guestCookieHeader } from "../src/api.js";

describe("backend domain and ports", () => {
  it.each([[{ a0: 10000 }, { a0: 10000 }, 100], [{ a0: 5000, a1: 5000 }, { a0: 10000, a1: 0 }, 50]])("scores basis-point vectors deterministically", (submitted, gto, expected) => {
    const result = l1Metric.score(Object.values(submitted), Object.values(gto));
    expect(result.similarity).toBe(expected);
  });

  it("keeps score action identity and signed deltas", () => {
    const result = scoreHands(["a0", "a1", "a2"], { a0: 729, a1: 9271, a2: 0 }, { a0: 0, a1: 10000, a2: 0 });
    expect.soft(result.gtoMajorityActionId).toBe("a1");
    expect.soft(result.actions).toHaveLength(3);
    expect.soft(result.actions[0]?.signedDifferenceBasisPoints).toBe(729);
  });

  it("uses injected in-memory repository and cache instead of global state", async () => {
    const repository = new InMemorySpotRepository([{ id: "spot_1", title: "Test" }]);
    expect(await repository.getById("spot_1")).toEqual({ id: "spot_1", title: "Test" });
    const cache = new InMemoryCacheStore(); let calls = 0;
    const loader = async () => { calls += 1; return { value: 42 }; };
    expect(await cached(cache, "answer", 30, loader)).toEqual({ value: 42 });
    expect(await cached(cache, "answer", 30, loader)).toEqual({ value: 42 });
    expect(calls).toBe(1);
  });

  it("requires an injected admin role and rejects missing identity", async () => {
    const request = { headers: {}, socket: {} } as never;
    await expect(requireRole(new FakeIdentityProvider({ subject: "admin", roles: ["admin"] }), request, "admin")).resolves.toMatchObject({ subject: "admin" });
    await expect(requireRole(new FakeIdentityProvider(null), request, "admin")).rejects.toMatchObject<AppError>({ status: 401, code: "UNAUTHENTICATED" });
    await expect(requireRole(new FakeIdentityProvider({ subject: "guest", roles: [] }), request, "admin")).rejects.toMatchObject<AppError>({ status: 403, code: "FORBIDDEN" });
  });

  it("keeps OIDC token parsing behind an injected verifier", async () => {
    const provider = new OidcIdentityProvider({ verifyBearerToken: async (token) => token === "good" ? { subject: "account-1", roles: ["user"] } : null });
    expect.soft(await provider.verify({ header: () => "Bearer good" } as never)).toMatchObject({ subject: "account-1" });
    expect.soft(await provider.verify({ headers: {}, header() { return undefined; } } as never)).toBeNull();
  });

  it.each([["127.0.0.1", true], ["::1", true], ["::ffff:127.0.0.1", true], ["10.0.0.2", false], ["", false]])("enforces loopback admin boundary for %s", (remoteAddress, expected) => {
    expect(isLoopbackRequest({ socket: { remoteAddress } } as never)).toBe(expected);
  });

  it("accepts the development proxy marker only when explicitly enabled", () => {
    const request = { socket: { remoteAddress: "172.18.0.3" }, headers: { "x-local-admin-proxy": "1" }, header(name: string) { return this.headers[name.toLowerCase()]; } } as never;
    expect(isLoopbackRequest(request, false)).toBe(false);
    expect(isLoopbackRequest(request, true)).toBe(true);
  });

  it("marks guest cookies Secure only when the deployment requests it", () => {
    expect(guestCookieHeader("guest", "abc", false)).not.toContain("Secure");
    expect(guestCookieHeader("guest", "abc", true)).toContain("Secure");
  });
});
