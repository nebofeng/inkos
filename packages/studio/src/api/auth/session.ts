/**
 * Stateless signed session tokens + a small persisted revocation list.
 *
 * Token: `v1.<payload base64url>.<HMAC-SHA256 base64url>`; payload is
 * `{ sid, u, iat, exp, pf }`. `pf` is an HMAC fingerprint of user + password
 * hash, so changing the password hash (or the session secret) invalidates
 * every existing session. Logout adds the sid to a revocation file in the data
 * dir, so it stays revoked across restarts until the token would expire anyway.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_VERSION = "v1";

export interface SessionPayload {
  readonly sid: string;
  readonly u: string;
  readonly iat: number;
  readonly exp: number;
  readonly pf: string;
}

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function credentialFingerprint(secret: string, user: string, passwordHash: string): string {
  return hmac(secret, `inkos-studio-pf\0${user}\0${passwordHash}`).toString("base64url").slice(0, 22);
}

export function signSession(secret: string, payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = hmac(secret, `${TOKEN_VERSION}.${body}`).toString("base64url");
  return `${TOKEN_VERSION}.${body}.${signature}`;
}

export function createSession(
  secret: string,
  user: string,
  passwordHash: string,
  now: number = Date.now(),
  ttlMs: number = SESSION_TTL_MS,
): { readonly token: string; readonly payload: SessionPayload } {
  const payload: SessionPayload = {
    sid: randomBytes(18).toString("base64url"),
    u: user,
    iat: now,
    exp: now + ttlMs,
    pf: credentialFingerprint(secret, user, passwordHash),
  };
  return { token: signSession(secret, payload), payload };
}

export type SessionVerifyResult =
  | { readonly ok: true; readonly payload: SessionPayload }
  | { readonly ok: false; readonly reason: "malformed" | "bad-signature" | "expired" | "credentials-changed" | "revoked" };

export function verifySession(
  token: string | null | undefined,
  options: {
    readonly secret: string;
    readonly user: string;
    readonly passwordHash: string;
    readonly now?: number;
    readonly isRevoked?: (sid: string) => boolean;
  },
): SessionVerifyResult {
  if (typeof token !== "string" || token.length > 2048) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: "malformed" };
  const [, body, signature] = parts as [string, string, string];
  const expected = hmac(options.secret, `${TOKEN_VERSION}.${body}`);
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad-signature" };
  }
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload.sid !== "string" || typeof payload.exp !== "number" || typeof payload.pf !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const now = options.now ?? Date.now();
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  const pf = credentialFingerprint(options.secret, options.user, options.passwordHash);
  if (payload.u !== options.user || payload.pf !== pf) return { ok: false, reason: "credentials-changed" };
  if (options.isRevoked?.(payload.sid)) return { ok: false, reason: "revoked" };
  return { ok: true, payload };
}

/** sid → exp (ms). Persisted as JSON with 0600 permissions. */
export class RevocationStore {
  private readonly entries = new Map<string, number>();
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string | null, private readonly now: () => number) {}

  static async open(filePath: string | null, now: () => number = Date.now): Promise<RevocationStore> {
    const store = new RevocationStore(filePath, now);
    if (filePath) {
      try {
        const raw = JSON.parse(await readFile(filePath, "utf8")) as { revoked?: Record<string, number> };
        for (const [sid, exp] of Object.entries(raw.revoked ?? {})) {
          if (typeof exp === "number") store.entries.set(sid, exp);
        }
      } catch {
        // missing / unreadable file → start empty
      }
    }
    store.prune();
    return store;
  }

  has(sid: string): boolean {
    const exp = this.entries.get(sid);
    if (exp === undefined) return false;
    if (exp <= this.now()) {
      this.entries.delete(sid);
      return false;
    }
    return true;
  }

  async revoke(sid: string, exp: number): Promise<void> {
    this.entries.set(sid, exp);
    this.prune();
    await this.persist();
  }

  private prune(): void {
    const now = this.now();
    for (const [sid, exp] of this.entries) if (exp <= now) this.entries.delete(sid);
  }

  private persist(): Promise<void> {
    const filePath = this.filePath;
    if (!filePath) return Promise.resolve();
    const snapshot = JSON.stringify({ revoked: Object.fromEntries(this.entries) });
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, filePath);
    });
    return this.writeChain;
  }

  get size(): number {
    return this.entries.size;
  }
}
