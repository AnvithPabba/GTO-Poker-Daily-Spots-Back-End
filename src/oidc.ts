import type { Request } from "express";
import type { IdentityProvider, Principal } from "./ports.js";

/** Provider-neutral OIDC boundary; a JWKS library is injected by deployment. */
export interface OidcVerifier { verifyBearerToken(token: string): Promise<Principal | null>; }

export class OidcIdentityProvider implements IdentityProvider {
  public constructor(private readonly verifier: OidcVerifier) {}
  public async verify(request: Request): Promise<Principal | null> {
    const header = request.header("authorization");
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    return token ? this.verifier.verifyBearerToken(token) : null;
  }
}
