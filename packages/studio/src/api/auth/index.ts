/**
 * Studio login gate. Installed into the Hono app before any other route by
 * createStudioServer() when the standalone runner passes an auth runtime.
 *
 * Public (no session): GET /healthz, GET /login, POST /api/v1/auth/login,
 * POST /api/v1/auth/logout (only clears / revokes its own cookie).
 * Everything else requires a valid session cookie:
 *   - /api/* and non-GET requests → 401 JSON `{ error: { code: "AUTH_REQUIRED" } }`
 *   - GET page navigations → 302 /login?next=<path>
 * The app never reads or sets the `Authorization` header, so it coexists with
 * a reverse proxy's HTTP Basic Auth.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { normalizeIp, resolveClientIp } from "./client-ip.js";
import { resolveStudioAuthConfig, type StudioAuthConfig } from "./config.js";
import { renderLoginPage, renderUnconfiguredPage, sanitizeNextPath } from "./pages.js";
import { verifyPassword } from "./password.js";
import { LoginRateLimiter } from "./rate-limit.js";
import { RevocationStore, SESSION_TTL_MS, createSession, verifySession, type SessionPayload } from "./session.js";

export const SESSION_COOKIE = "inkos_studio_session";
const MAX_FIELD_LENGTH = 1024;

export interface StudioAuthRuntime {
  readonly config: StudioAuthConfig;
  readonly limiter: LoginRateLimiter;
  readonly revocations: RevocationStore;
  readonly now: () => number;
  readonly log: (message: string) => void;
  /** Direct TCP peer address; defaults to @hono/node-server's `c.env.incoming.socket`. */
  readonly getPeerAddress: (c: Context) => string | undefined;
}

function defaultPeerAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

export async function createStudioAuthRuntime(options: {
  readonly root: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly getPeerAddress?: (c: Context) => string | undefined;
  readonly limiter?: LoginRateLimiter;
}): Promise<StudioAuthRuntime> {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(message));
  const config = await resolveStudioAuthConfig({ root: options.root, env: options.env ?? process.env });
  const revocations = await RevocationStore.open(config.mode === "enabled" ? config.revocationFile : null, now);
  for (const warning of config.warnings) log(`[studio-auth] 警告：${warning}`);
  if (config.mode === "enabled") {
    log(
      `[studio-auth] 登录已启用：用户名来源=${config.credentialSource}，会话密钥来源=${config.sessionSecretSource}，`
        + `Secure cookie=${config.cookieSecure ? "on" : "off"}，trusted proxies=${config.trustedProxies.entries.join(",") || "(无，使用直连地址)"}`,
    );
  } else if (config.mode === "unconfigured") {
    const bar = "=".repeat(66);
    log(`[studio-auth] ${bar}`);
    log("[studio-auth] Studio 登录未配置，已拒绝所有访问（/healthz 返回 503）。");
    log(`[studio-auth] 原因：${config.reason}`);
    log("[studio-auth] 生成密码哈希：docker-compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs");
    log("[studio-auth]   （插件版：docker compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs）");
    log("[studio-auth] 然后在 .env 设置 INKOS_STUDIO_USER / INKOS_STUDIO_PASSWORD_HASH 并重新 up -d。");
    log(`[studio-auth] ${bar}`);
  }
  return {
    config,
    limiter: options.limiter ?? new LoginRateLimiter({ now }),
    revocations,
    now,
    log,
    getPeerAddress: options.getPeerAddress ?? defaultPeerAddress,
  };
}

function nonce(): string {
  return randomBytes(16).toString("base64");
}

function pageHeaders(c: Context, n: string): void {
  c.header("Cache-Control", "no-store");
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}'; connect-src 'self'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
}

function sameText(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function authError(c: Context, status: 401 | 400 | 429 | 503, code: string, message: string) {
  c.header("Cache-Control", "no-store");
  return c.json({ error: { code, message } }, status);
}

async function readCredentials(c: Context): Promise<{ username: string; password: string; next: string; form: boolean } | null> {
  const contentType = c.req.header("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = await c.req.json<Record<string, unknown>>();
      return {
        username: typeof body.username === "string" ? body.username.trim() : "",
        password: typeof body.password === "string" ? body.password : "",
        next: typeof body.next === "string" ? body.next : "/",
        form: false,
      };
    }
    if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      return {
        username: typeof body.username === "string" ? body.username.trim() : "",
        password: typeof body.password === "string" ? body.password : "",
        next: typeof body.next === "string" ? body.next : "/",
        form: true,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function installStudioAuth(app: Hono, runtime: StudioAuthRuntime): void {
  const { config, limiter, revocations, log } = runtime;

  const clientIp = (c: Context): { ip: string; peer: string } => {
    const rawPeer = runtime.getPeerAddress(c);
    const peer = normalizeIp(rawPeer) || "unknown";
    if (config.mode !== "enabled") return { ip: peer, peer };
    return { ip: resolveClientIp(peer, c.req.header("x-forwarded-for"), config.trustedProxies), peer };
  };

  const currentSession = (c: Context): SessionPayload | null => {
    if (config.mode !== "enabled") return null;
    const result = verifySession(getCookie(c, SESSION_COOKIE), {
      secret: config.sessionSecret,
      user: config.user,
      passwordHash: config.passwordHash,
      now: runtime.now(),
      isRevoked: (sid) => revocations.has(sid),
    });
    return result.ok ? result.payload : null;
  };

  const clearCookie = (c: Context) => {
    deleteCookie(c, SESSION_COOKIE, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: config.mode === "enabled" ? config.cookieSecure : true,
    });
  };

  // --- Health (always public, no sensitive data) ---
  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    if (config.mode === "unconfigured") return c.json({ ok: false }, 503);
    return c.json({ ok: true });
  });

  // --- Login page ---
  app.get("/login", (c) => {
    const n = nonce();
    pageHeaders(c, n);
    if (config.mode === "unconfigured") return c.html(renderUnconfiguredPage({ reason: config.reason, nonce: n }), 503);
    const next = sanitizeNextPath(c.req.query("next"));
    if (config.mode === "disabled" || currentSession(c)) return c.redirect(next, 302);
    const error = c.req.query("error") === "locked"
      ? "尝试次数过多，已暂时锁定，请稍后再试"
      : c.req.query("error") ? "用户名或密码错误" : undefined;
    return c.html(renderLoginPage({ next, nonce: n, error }));
  });

  app.post("/api/v1/auth/login", async (c) => {
    if (config.mode === "unconfigured") return authError(c, 503, "AUTH_NOT_CONFIGURED", `Studio 登录未配置：${config.reason}`);
    if (config.mode === "disabled") return c.json({ ok: true, authDisabled: true });

    const { ip, peer } = clientIp(c);
    const credentials = await readCredentials(c);
    const formMode = credentials?.form ?? false;
    const next = sanitizeNextPath(credentials?.next);
    const formRedirect = (error: string) => c.redirect(`/login?error=${error}&next=${encodeURIComponent(next)}`, 303);

    const before = limiter.check(ip);
    if (!before.allowed) {
      log(`[studio-auth] 登录被限流 ip=${ip} peer=${peer} retryAfter=${before.retryAfterSeconds}s`);
      c.header("Retry-After", String(before.retryAfterSeconds));
      if (formMode) return formRedirect("locked");
      return authError(c, 429, "TOO_MANY_ATTEMPTS", `尝试次数过多，请 ${Math.ceil(before.retryAfterSeconds / 60)} 分钟后再试`);
    }

    if (!credentials || !credentials.username || !credentials.password
      || credentials.username.length > MAX_FIELD_LENGTH || credentials.password.length > MAX_FIELD_LENGTH) {
      if (formMode) return formRedirect("1");
      return authError(c, 400, "INVALID_REQUEST", "请输入用户名和密码");
    }

    // Always run scrypt, even for a wrong username, so timing does not reveal it.
    const passwordOk = await verifyPassword(credentials.password, config.passwordHash);
    const userOk = sameText(credentials.username, config.user);
    if (!(passwordOk && userOk)) {
      const after = limiter.recordFailure(ip);
      log(`[studio-auth] 登录失败 ip=${ip} peer=${peer} 失败次数=${after.failures}/${limiter.maxFailures}`);
      if (!after.allowed) {
        c.header("Retry-After", String(after.retryAfterSeconds));
        if (formMode) return formRedirect("locked");
        return authError(c, 429, "TOO_MANY_ATTEMPTS", `失败次数过多，已锁定 ${Math.ceil(after.retryAfterSeconds / 60)} 分钟`);
      }
      if (formMode) return formRedirect("1");
      return authError(c, 401, "INVALID_CREDENTIALS", "用户名或密码错误");
    }

    limiter.recordSuccess(ip);
    const { token, payload } = createSession(config.sessionSecret, config.user, config.passwordHash, runtime.now());
    setCookie(c, SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "Lax",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      expires: new Date(payload.exp),
    });
    log(`[studio-auth] 登录成功 ip=${ip} peer=${peer}`);
    c.header("Cache-Control", "no-store");
    if (formMode) return c.redirect(next, 303);
    return c.json({ ok: true, user: config.user, expiresAt: new Date(payload.exp).toISOString(), next });
  });

  app.post("/api/v1/auth/logout", async (c) => {
    if (config.mode === "enabled") {
      const session = currentSession(c);
      if (session) {
        await revocations.revoke(session.sid, session.exp);
        log(`[studio-auth] 已退出登录 ip=${clientIp(c).ip}`);
      }
    }
    clearCookie(c);
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true });
  });

  // --- Gate: everything registered after this point needs a session ---
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const isApi = path === "/api" || path.startsWith("/api/");

    if (config.mode === "disabled") {
      if (path === "/api/v1/auth/session") return c.json({ authenticated: true, authDisabled: true, user: null, expiresAt: null });
      return next();
    }

    if (config.mode === "unconfigured") {
      if (isApi) return authError(c, 503, "AUTH_NOT_CONFIGURED", `Studio 登录未配置，已拒绝访问：${config.reason}`);
      const n = nonce();
      pageHeaders(c, n);
      return c.html(renderUnconfiguredPage({ reason: config.reason, nonce: n }), 503);
    }

    const session = currentSession(c);
    if (session) {
      c.set("studioUser" as never, session.u as never);
      if (path === "/api/v1/auth/session") {
        c.header("Cache-Control", "no-store");
        return c.json({ authenticated: true, authDisabled: false, user: session.u, expiresAt: new Date(session.exp).toISOString() });
      }
      return next();
    }

    // Drop a stale/invalid cookie so the browser stops sending it.
    if (getCookie(c, SESSION_COOKIE) !== undefined) clearCookie(c);

    const method = c.req.method;
    if (!isApi && (method === "GET" || method === "HEAD") && !path.startsWith("/assets/")) {
      const url = new URL(c.req.url);
      const target = sanitizeNextPath(`${url.pathname}${url.search}`);
      c.header("Cache-Control", "no-store");
      return c.redirect(`/login?next=${encodeURIComponent(target)}`, 302);
    }
    return authError(c, 401, "AUTH_REQUIRED", "未登录或登录已过期，请重新登录");
  });
}

export { resolveStudioAuthConfig } from "./config.js";
export { hashPassword, verifyPassword, isPasswordHash } from "./password.js";
export { maskSecret, isMaskedSecret, resolveMaskedSecret } from "./mask.js";
