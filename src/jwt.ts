import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { PlanError } from "./errors.js";

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  name?: string;
  [claim: string]: unknown;
}

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
}

const ALGS: Record<string, { hash: string; ec?: boolean; pss?: boolean }> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  PS256: { hash: "sha256", pss: true },
  ES256: { hash: "sha256", ec: true },
  ES384: { hash: "sha384", ec: true },
};

function b64urlJson(part: string): any {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export function decodeJwt(token: string): { header: any; payload: any } {
  const [h, p] = token.split(".");
  if (!h || !p) throw new PlanError("invalid_id_token", "Malformed JWT");
  return { header: b64urlJson(h), payload: b64urlJson(p) };
}

/** Verify an OIDC ID token's signature against a JWKS, then its issuer, audience, expiry, and nonce. */
export function verifyIdToken(
  token: string,
  jwks: { keys: Jwk[] },
  expected: { issuer: string; audience: string; nonce: string; now?: number; skewSeconds?: number },
): IdTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new PlanError("invalid_id_token", "Malformed ID token");
  const { header, payload } = decodeJwt(token);

  const alg = ALGS[header.alg];
  if (!alg) throw new PlanError("invalid_id_token", `Unsupported ID token alg: ${header.alg}`);
  const jwk = jwks.keys.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.alg || k.alg === header.alg));
  if (!jwk) throw new PlanError("invalid_id_token", "No matching signing key in JWKS");

  const key = createPublicKey({ key: jwk, format: "jwk" });
  const ok = verify(
    alg.hash,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    alg.ec
      ? { key, dsaEncoding: "ieee-p1363" }
      : alg.pss
        ? { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 }
        : key,
    Buffer.from(parts[2], "base64url"),
  );
  if (!ok) throw new PlanError("invalid_id_token", "ID token signature is invalid");

  const claims = payload as IdTokenClaims;
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  const skew = expected.skewSeconds ?? 120;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (claims.iss !== expected.issuer) throw new PlanError("invalid_id_token", `Unexpected issuer: ${claims.iss}`);
  if (!aud.includes(expected.audience)) throw new PlanError("invalid_id_token", "ID token audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new PlanError("invalid_id_token", "ID token expired");
  if (claims.nonce !== expected.nonce) throw new PlanError("invalid_id_token", "ID token nonce mismatch");
  if (!claims.sub) throw new PlanError("invalid_id_token", "ID token has no subject");
  return claims;
}
