import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildLoginUrl, installAuthFetchGuard, isAuthRequiredResponse, logout, resetAuthClientStateForTests } from "./auth-client";

const ORIGIN = "https://studio.example";

function fakeLocation(path = "/", search = "", hash = "") {
  return { pathname: path, search, hash, origin: ORIGIN, replace: vi.fn() };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => resetAuthClientStateForTests());

describe("auth client", () => {
  it("builds a login URL that returns to the current page including the hash route", () => {
    expect(buildLoginUrl({ pathname: "/", search: "", hash: "#/book/b1" })).toBe(`/login?next=${encodeURIComponent("/#/book/b1")}`);
    expect(buildLoginUrl({ pathname: "/", search: "", hash: "" })).toBe("/login");
    expect(buildLoginUrl({ pathname: "/login", search: "?next=%2F", hash: "" })).toBe("/login");
  });

  it("only same-origin /api 401 AUTH_REQUIRED counts as logged out", async () => {
    expect(await isAuthRequiredResponse("/api/v1/books", json(401, { error: { code: "AUTH_REQUIRED" } }), ORIGIN)).toBe(true);
    expect(await isAuthRequiredResponse("/api/v1/auth/login", json(401, { error: { code: "AUTH_REQUIRED" } }), ORIGIN)).toBe(false);
    expect(await isAuthRequiredResponse("/api/v1/services/x/test", json(401, { error: "upstream 401" }), ORIGIN)).toBe(false);
    expect(await isAuthRequiredResponse("https://other.example/api/v1/books", json(401, { error: { code: "AUTH_REQUIRED" } }), ORIGIN)).toBe(false);
    expect(await isAuthRequiredResponse("/api/v1/books", json(200, {}), ORIGIN)).toBe(false);
  });

  it("the fetch guard redirects to /login?next=… once and still returns the response", async () => {
    const location = fakeLocation("/", "", "#/chat");
    const target = { fetch: vi.fn(async () => json(401, { error: { code: "AUTH_REQUIRED" } })) as unknown as typeof fetch, location };
    installAuthFetchGuard(target);
    installAuthFetchGuard(target); // idempotent
    const res = await target.fetch("/api/v1/books");
    expect(res.status).toBe(401);
    await target.fetch("/api/v1/books");
    expect(location.replace).toHaveBeenCalledTimes(1);
    expect(location.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/#/chat")}`);
  });

  it("logout posts to the server and goes to the login page", async () => {
    const location = fakeLocation();
    const fetchMock = vi.fn(async () => json(200, { ok: true }));
    await logout({ fetch: fetchMock as unknown as typeof fetch, location });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" });
    expect(location.replace).toHaveBeenCalledWith("/login");
  });
});
