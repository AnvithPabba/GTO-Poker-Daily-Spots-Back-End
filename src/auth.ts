import type { Request } from "express";
import { AppError } from "./errors.js";
import type { IdentityProvider, Principal } from "./ports.js";

export async function requirePrincipal(provider: IdentityProvider, request: Request): Promise<Principal> {
  const principal = await provider.verify(request);
  if (!principal) throw new AppError("UNAUTHENTICATED", "authentication is required", 401);
  return principal;
}

export async function requireRole(provider: IdentityProvider, request: Request, role: string): Promise<Principal> {
  const principal = await requirePrincipal(provider, request);
  if (!principal.roles.includes(role)) throw new AppError("FORBIDDEN", "required role is missing", 403);
  return principal;
}
