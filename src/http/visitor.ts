import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import type { IdentityProvider } from "../ports.js";
import type { Visitor } from "../application/public-api.js";

export type VisitorOptions = {
  prisma: PrismaClient;
  guestCookieHashSecret: string;
  guestCookieName: string;
  secureCookies: boolean;
  identityProvider?: IdentityProvider;
};

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.header("cookie");
  return header?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function tokenHash(token: string, secret: string): string { return createHash("sha256").update(`${secret}:${token}`).digest("hex"); }

export function guestCookieHeader(name: string, token: string, secure: boolean): string {
  return [`${name}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=31536000", ...(secure ? ["Secure"] : [])].join("; ");
}

export async function resolveVisitor(request: Request, response: Response, options: VisitorOptions): Promise<Visitor> {
  const principal = options.identityProvider ? await options.identityProvider.verify(request) : null;
  if (principal) {
    const account = await options.prisma.account.upsert({ where: { subject: principal.subject }, create: { subject: principal.subject, email: principal.email ?? null, roles: principal.roles }, update: { email: principal.email ?? null, roles: principal.roles } });
    return { kind: "account", accountId: account.id };
  }
  const supplied = cookieValue(request, options.guestCookieName);
  const validToken = supplied && /^[A-Za-z0-9_-]{32,256}$/.test(supplied) ? supplied : undefined;
  const now = new Date();
  const existing = validToken ? await options.prisma.guestSession.findUnique({ where: { tokenHash: tokenHash(validToken, options.guestCookieHashSecret) } }) : null;
  const active = existing && !existing.revokedAt && existing.expiresAt > now;
  const shouldRotate = Boolean(active && existing.createdAt.getTime() < now.getTime() - 30 * 86_400_000);
  if (active && !shouldRotate) {
    const session = await options.prisma.guestSession.update({ where: { id: existing.id }, data: { lastSeenAt: now } });
    return { kind: "guest", identityId: session.identityId, sessionId: session.id };
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + 365 * 86_400_000);
  const session = await options.prisma.$transaction(async (tx) => {
    if (existing) await tx.guestSession.update({ where: { id: existing.id }, data: { revokedAt: now, lastSeenAt: now } });
    const identityId = existing?.identityId ?? (await tx.guestIdentity.create({ data: {} })).id;
    return tx.guestSession.create({ data: { identityId, tokenHash: tokenHash(token, options.guestCookieHashSecret), expiresAt, ...(existing ? { rotationOfId: existing.id } : {}) } });
  });
  response.setHeader("Set-Cookie", guestCookieHeader(options.guestCookieName, token, options.secureCookies));
  return { kind: "guest", identityId: session.identityId, sessionId: session.id };
}
