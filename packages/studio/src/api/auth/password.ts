/**
 * Studio login password hashing (scrypt via node:crypto, no native deps).
 *
 * Encoded format (no `$`, so it is safe in docker-compose .env files where `$`
 * would be interpolated):
 *
 *   scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const PASSWORD_HASH_PREFIX = "scrypt";
export const DEFAULT_SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_N = 1 << 20;

export interface ParsedPasswordHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

function scryptOptions(N: number, r: number, p: number): ScryptOptions {
  // Node's default maxmem (32 MiB) is exactly 128*N*r for N=32768,r=8, which
  // scrypt rejects; give it headroom.
  return { N, r, p, maxmem: 128 * N * r * 2 + 1024 * 1024 };
}

const B64URL = /^[A-Za-z0-9_-]+$/;

export function parsePasswordHash(encoded: string): ParsedPasswordHash | null {
  if (typeof encoded !== "string") return null;
  const parts = encoded.trim().split(":");
  if (parts.length !== 6 || parts[0] !== PASSWORD_HASH_PREFIX) return null;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string];
  if (!/^\d+$/.test(nRaw) || !/^\d+$/.test(rRaw) || !/^\d+$/.test(pRaw)) return null;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  // N must be a power of two > 1; keep r/p/N in sane bounds so a bad value
  // cannot be used to burn CPU/memory.
  if (N < 2 || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (r < 1 || r > 32 || p < 1 || p > 16) return null;
  if (!B64URL.test(saltRaw) || !B64URL.test(hashRaw)) return null;
  const salt = Buffer.from(saltRaw, "base64url");
  const hash = Buffer.from(hashRaw, "base64url");
  if (salt.length < 8 || hash.length < 16 || hash.length > 128) return null;
  return { N, r, p, salt, hash };
}

export function isPasswordHash(encoded: string): boolean {
  return parsePasswordHash(encoded) !== null;
}

export async function hashPassword(
  password: string,
  params: { readonly N?: number; readonly r?: number; readonly p?: number; readonly salt?: Buffer } = {},
): Promise<string> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must not be empty");
  }
  const N = params.N ?? DEFAULT_SCRYPT_PARAMS.N;
  const r = params.r ?? DEFAULT_SCRYPT_PARAMS.r;
  const p = params.p ?? DEFAULT_SCRYPT_PARAMS.p;
  const salt = params.salt ?? randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, scryptOptions(N, r, p));
  const encoded = [PASSWORD_HASH_PREFIX, N, r, p, salt.toString("base64url"), derived.toString("base64url")].join(":");
  if (!isPasswordHash(encoded)) throw new Error("invalid scrypt parameters");
  return encoded;
}

/** Constant-time verification. Returns false (never throws) for malformed hashes. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed || typeof password !== "string") return false;
  try {
    const derived = await scrypt(password, parsed.salt, parsed.hash.length, scryptOptions(parsed.N, parsed.r, parsed.p));
    return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}
