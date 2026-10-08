import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createStudioAuthRuntime, installStudioAuth, SESSION_COOKIE } from "./index.js";
import { hashPassword } from "./password.js";

const PASSWORD = "fake-gate-password";
let root: string;
let hash: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inkos-auth-gate-"));
  hash = await hashPassword(PASSWORD, { N: 1024 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function makeApp(env: Record<string, string>, clock?: { now: () => number }) {
  const logs: string[] = [];
  const runtime = await createStudioAuthRuntime({
    root,
    env,
    log: (m) => logs.push(m),
    now: clock?.now,
    getPeerAddress: (c) => c.req.header("x-test-peer") ?? "127.0.0.1",
  });
  const app = new Hono();
  installStudioAuth(app, runtime);
  app.get("/api/v1/books", (c) => c.json({ books: [{ id: "b1", title: "secret-title" }] }));
  app.post("/api/v1/books/create", (c) => c.json({ ok: true }));
  app.get("/api/v1/events", (c) => streamSSE(c, async (s) => { await s.writeSSE({ event: "ping", data: "{}" }); }));
  app.get("/assets/*", (c) => c.text("js"));
  app.get("*", (c) => c.html("<div id=root></div>"));
  return { app, logs, runtime };
}

const ENV = () => ({ INKOS_STUDIO_USER: "writer", INKOS_STUDIO_PASSWORD_HASH: hash });

async function login(app: Hono, password = PASSWORD, peer = "127.0.0.1", extra: Record<string, string> = {}) {
  return app.request("http://studio.test/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-peer": peer, ...extra },
    body: JSON.stringify({ username: "writer", password }),
  });
}

function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0]!;
}

describe("studio auth gate", () => {
  it("healthz is public and reveals nothing", async () => {
    const { app } = await makeApp(ENV());
    const res = await app.request("http://studio.test/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("unauthenticated /api (JSON, POST, SSE) → 401 JSON; pages → 302 /login?next; assets → 401", async () => {
    const { app } = await makeApp(ENV());
    for (const [path, method] of [["/api/v1/books", "GET"], ["/api/v1/books/create", "POST"], ["/api/v1/events", "GET"], ["/api/v1/nope", "GET"]] as const) {
      const res = await app.request(`http://studio.test${path}`, { method });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "AUTH_REQUIRED", message: expect.any(String) } });
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
    const page = await app.request("http://studio.test/books?tab=1");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`/login?next=${encodeURIComponent("/books?tab=1")}`);
    expect((await app.request("http://studio.test/assets/index.js")).status).toBe(401);
  });

  it("login page is Chinese, mobile-friendly and keeps the return target", async () => {
    const { app } = await makeApp(ENV());
    const res = await app.request("http://studio.test/login?next=%2Fbooks%3Fx%3D1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain("width=device-width");
    expect(html).toContain("用户名");
    expect(html).toContain('"/books?x=1"');
    expect(html).toContain("location.hash");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // open-redirect attempts collapse to "/"
    const evil = await (await app.request("http://studio.test/login?next=%2F%2Fevil.example")).text();
    expect(evil).toContain('var NEXT="/"');
  });

  it("wrong password → 401; correct login sets a HttpOnly Secure SameSite=Lax 30-day cookie that unlocks /api and SSE", async () => {
    const { app } = await makeApp(ENV());
    const bad = await login(app, "wrong-password");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();

    const ok = await login(app);
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=v1.`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=2592000/);
    expect(setCookie).toMatch(/Path=\//);
    const body = await ok.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(PASSWORD);

    const cookie = cookieFrom(ok);
    const books = await app.request("http://studio.test/api/v1/books", { headers: { Cookie: cookie } });
    expect(books.status).toBe(200);
    const sse = await app.request("http://studio.test/api/v1/events", { headers: { Cookie: cookie } });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const session = await app.request("http://studio.test/api/v1/auth/session", { headers: { Cookie: cookie } });
    expect(await session.json()).toMatchObject({ authenticated: true, user: "writer", authDisabled: false });
    // ignores Basic-Auth style Authorization header entirely
    const withBasic = await app.request("http://studio.test/api/v1/books", { headers: { Authorization: "Basic dXNlcjpwYXNz" } });
    expect(withBasic.status).toBe(401);
    const withBoth = await app.request("http://studio.test/api/v1/books", { headers: { Authorization: "Basic dXNlcjpwYXNz", Cookie: cookie } });
    expect(withBoth.status).toBe(200);
  });

  it("form POST fallback redirects (303) to next", async () => {
    const { app } = await makeApp(ENV());
    const res = await app.request("http://studio.test/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "writer", password: PASSWORD, next: "/#/book/b1" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/#/book/b1");
  });

  it("5 failures from one IP → 429 + Retry-After, even for the right password; other IPs unaffected", async () => {
    const { app } = await makeApp(ENV());
    for (let i = 1; i <= 4; i += 1) expect((await login(app, `bad-${i}`, "203.0.113.10")).status).toBe(401);
    const fifth = await login(app, "bad-5", "203.0.113.10");
    expect(fifth.status).toBe(429);
    expect(Number(fifth.headers.get("retry-after"))).toBeGreaterThan(800);
    const locked = await login(app, PASSWORD, "203.0.113.10");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
    expect((await login(app, PASSWORD, "203.0.113.11")).status).toBe(200);
  });

  it("X-Forwarded-For is only trusted from INKOS_TRUSTED_PROXIES", async () => {
    const untrusted = await makeApp(ENV());
    for (let i = 0; i < 5; i += 1) await login(untrusted.app, "bad", "172.20.0.1", { "X-Forwarded-For": `198.51.100.${i}` });
    // all counted against the proxy peer, spoofed XFF ignored
    expect((await login(untrusted.app, PASSWORD, "172.20.0.1", { "X-Forwarded-For": "198.51.100.99" })).status).toBe(429);

    const trusted = await makeApp({ ...ENV(), INKOS_TRUSTED_PROXIES: "172.20.0.1" });
    for (let i = 0; i < 5; i += 1) await login(trusted.app, "bad", "172.20.0.1", { "X-Forwarded-For": "198.51.100.7" });
    expect((await login(trusted.app, PASSWORD, "172.20.0.1", { "X-Forwarded-For": "198.51.100.7" })).status).toBe(429);
    expect((await login(trusted.app, PASSWORD, "172.20.0.1", { "X-Forwarded-For": "198.51.100.8" })).status).toBe(200);
    expect(trusted.logs.join("\n")).toContain("peer=172.20.0.1");
  });

  it("logout revokes the session, also after a restart (new runtime, same data dir)", async () => {
    const first = await makeApp(ENV());
    const cookie = cookieFrom(await login(first.app));
    const keep = cookieFrom(await login(first.app));
    const out = await first.app.request("http://studio.test/api/v1/auth/logout", { method: "POST", headers: { Cookie: cookie } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await first.app.request("http://studio.test/api/v1/books", { headers: { Cookie: cookie } })).status).toBe(401);

    const restarted = await makeApp(ENV());
    expect((await restarted.app.request("http://studio.test/api/v1/books", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await restarted.app.request("http://studio.test/api/v1/books", { headers: { Cookie: keep } })).status).toBe(200);
  });

  it("changing the password hash invalidates existing sessions", async () => {
    const first = await makeApp(ENV());
    const cookie = cookieFrom(await login(first.app));
    const newHash = await hashPassword("fake-new-password", { N: 1024 });
    const changed = await makeApp({ INKOS_STUDIO_USER: "writer", INKOS_STUDIO_PASSWORD_HASH: newHash });
    expect((await changed.app.request("http://studio.test/api/v1/books", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("expired sessions are rejected", async () => {
    let t = Date.now();
    const { app } = await makeApp(ENV(), { now: () => t });
    const cookie = cookieFrom(await login(app));
    t += 30 * 24 * 3600 * 1000 + 1;
    expect((await app.request("http://studio.test/api/v1/books", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("no login configured → everything refused (503), healthz unhealthy, nothing leaks", async () => {
    const { app, logs } = await makeApp({});
    const api = await app.request("http://studio.test/api/v1/books");
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ error: { code: "AUTH_NOT_CONFIGURED" } });
    const page = await app.request("http://studio.test/");
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("hash-password");
    expect((await app.request("http://studio.test/login")).status).toBe(503);
    expect((await login(app)).status).toBe(503);
    const health = await app.request("http://studio.test/healthz");
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ ok: false });
    expect(logs.join("\n")).toContain("登录未配置");
  });

  it("INKOS_STUDIO_AUTH=off passes everything through (documented as dangerous)", async () => {
    const { app, logs } = await makeApp({ INKOS_STUDIO_AUTH: "off" });
    expect((await app.request("http://studio.test/api/v1/books")).status).toBe(200);
    expect(await (await app.request("http://studio.test/api/v1/auth/session")).json()).toMatchObject({ authDisabled: true });
    expect(logs.join("\n")).toContain("INKOS_STUDIO_AUTH=off");
  });

  it("INKOS_STUDIO_COOKIE_SECURE=0 drops only the Secure flag", async () => {
    const { app } = await makeApp({ ...ENV(), INKOS_STUDIO_COOKIE_SECURE: "0" });
    const setCookie = (await login(app)).headers.get("set-cookie") ?? "";
    expect(setCookie).not.toMatch(/Secure/i);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });
});
