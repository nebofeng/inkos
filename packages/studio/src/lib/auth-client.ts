/**
 * Browser side of the Studio login (server: src/api/auth).
 * - A global fetch guard sends the user to /login?next=<current page> when an
 *   /api call answers 401 AUTH_REQUIRED (session expired / logged out elsewhere).
 * - logout() revokes the session server-side and goes to the login page.
 */
export const LOGIN_PATH = "/login";
export const AUTH_SESSION_URL = "/api/v1/auth/session";
export const AUTH_LOGOUT_URL = "/api/v1/auth/logout";
const AUTH_LOGIN_URL = "/api/v1/auth/login";

interface LocationLike {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly origin: string;
  replace(url: string): void;
}

export function buildLoginUrl(location: Pick<LocationLike, "pathname" | "search" | "hash">): string {
  const current = `${location.pathname}${location.search}${location.hash}`;
  if (!current || current === "/" || location.pathname === LOGIN_PATH) return LOGIN_PATH;
  return `${LOGIN_PATH}?next=${encodeURIComponent(current)}`;
}

function requestUrl(input: RequestInfo | URL, origin: string): URL | null {
  try {
    if (typeof input === "string") return new URL(input, origin);
    if (input instanceof URL) return input;
    return new URL((input as Request).url, origin);
  } catch {
    return null;
  }
}

/** True when the response means "your Studio session is gone". */
export async function isAuthRequiredResponse(input: RequestInfo | URL, res: Response, origin: string): Promise<boolean> {
  if (res.status !== 401) return false;
  const url = requestUrl(input, origin);
  if (!url || url.origin !== origin || !url.pathname.startsWith("/api/")) return false;
  if (url.pathname === AUTH_LOGIN_URL) return false;
  try {
    const body = await res.clone().json() as { error?: { code?: unknown } };
    return body?.error?.code === "AUTH_REQUIRED";
  } catch {
    return false;
  }
}

let redirecting = false;

export function redirectToLogin(location: LocationLike = window.location): void {
  if (redirecting) return;
  redirecting = true;
  location.replace(buildLoginUrl(location));
}

export function installAuthFetchGuard(target: { fetch: typeof fetch; location: LocationLike } = window): void {
  const marker = target.fetch as typeof fetch & { __inkosAuthGuard?: true };
  if (marker.__inkosAuthGuard) return;
  const original = target.fetch.bind(target);
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    if (await isAuthRequiredResponse(input, res, target.location.origin)) redirectToLogin(target.location);
    return res;
  }) as typeof fetch & { __inkosAuthGuard?: true };
  guarded.__inkosAuthGuard = true;
  target.fetch = guarded;
}

let lastSessionCheck = 0;

/** EventSource cannot see HTTP status codes: after a stream error, ask the server whether we are still logged in. */
export function checkSessionAfterStreamError(now: number = Date.now()): void {
  if (typeof window === "undefined" || now - lastSessionCheck < 5000) return;
  lastSessionCheck = now;
  void fetch(AUTH_SESSION_URL, { credentials: "same-origin" }).catch(() => undefined);
}

export async function logout(target: { fetch: typeof fetch; location: LocationLike } = window): Promise<void> {
  try {
    await target.fetch(AUTH_LOGOUT_URL, { method: "POST", credentials: "same-origin" });
  } finally {
    target.location.replace(LOGIN_PATH);
  }
}

export function resetAuthClientStateForTests(): void {
  redirecting = false;
  lastSessionCheck = 0;
}
