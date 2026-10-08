import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RevocationStore, SESSION_TTL_MS, createSession, signSession, verifySession } from "./session.js";

const SECRET = "fake-session-secret-for-tests-0123456789";
const HASH = "scrypt:1024:8:1:c2FsdHNhbHRzYWx0:aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA";

describe("session tokens", () => {
  it("round-trips and lasts 30 days", () => {
    const now = 1_700_000_000_000;
    const { token, payload } = createSession(SECRET, "writer", HASH, now);
    expect(payload.exp - payload.iat).toBe(30 * 24 * 3600 * 1000);
    expect(SESSION_TTL_MS).toBe(30 * 24 * 3600 * 1000);
    expect(verifySession(token, { secret: SECRET, user: "writer", passwordHash: HASH, now: now + 1000 })).toMatchObject({ ok: true });
    expect(verifySession(token, { secret: SECRET, user: "writer", passwordHash: HASH, now: payload.exp })).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects tampering and a different secret", () => {
    const { token, payload } = createSession(SECRET, "writer", HASH);
    const forged = signSession("another-secret-another-secret-xx", { ...payload, exp: payload.exp + 1 });
    expect(verifySession(forged, { secret: SECRET, user: "writer", passwordHash: HASH })).toEqual({ ok: false, reason: "bad-signature" });
    const [v, body, sig] = token.split(".");
    const tampered = `${v}.${Buffer.from(JSON.stringify({ ...payload, u: "admin" })).toString("base64url")}.${sig}`;
    expect(verifySession(tampered, { secret: SECRET, user: "writer", passwordHash: HASH })).toEqual({ ok: false, reason: "bad-signature" });
    expect(body).toBeTruthy();
    expect(verifySession("garbage", { secret: SECRET, user: "writer", passwordHash: HASH })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySession(undefined, { secret: SECRET, user: "writer", passwordHash: HASH })).toEqual({ ok: false, reason: "malformed" });
  });

  it("changing the password hash or user invalidates old sessions", () => {
    const { token } = createSession(SECRET, "writer", HASH);
    const newHash = HASH.replace("aGFzaGhh", "bmV3aGFz");
    expect(verifySession(token, { secret: SECRET, user: "writer", passwordHash: newHash })).toEqual({ ok: false, reason: "credentials-changed" });
    expect(verifySession(token, { secret: SECRET, user: "editor", passwordHash: HASH })).toEqual({ ok: false, reason: "credentials-changed" });
  });

  it("honours revocation", () => {
    const { token, payload } = createSession(SECRET, "writer", HASH);
    expect(verifySession(token, { secret: SECRET, user: "writer", passwordHash: HASH, isRevoked: (sid) => sid === payload.sid })).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("RevocationStore", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "inkos-auth-rev-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("persists revocations with 0600 permissions and survives reopen", async () => {
    const file = join(dir, ".inkos", "studio-auth-revoked.json");
    let t = 1000;
    const store = await RevocationStore.open(file, () => t);
    await store.revoke("sid-1", 5000);
    expect(store.has("sid-1")).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const reopened = await RevocationStore.open(file, () => t);
    expect(reopened.has("sid-1")).toBe(true);
    t = 6000;
    expect(reopened.has("sid-1")).toBe(false);
    await reopened.revoke("sid-2", 9000);
    expect(JSON.parse(await readFile(file, "utf8")).revoked).toEqual({ "sid-2": 9000 });
  });
});
