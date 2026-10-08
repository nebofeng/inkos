import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveStudioAuthConfig, SESSION_SECRET_FILE } from "./config.js";
import { hashPassword } from "./password.js";

let root: string;
let hash: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inkos-auth-cfg-"));
  hash = await hashPassword("fake-config-password", { N: 1024 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function writeSecrets(content: unknown) {
  await mkdir(join(root, ".inkos"), { recursive: true });
  await writeFile(join(root, ".inkos", "secrets.json"), JSON.stringify(content));
}

describe("resolveStudioAuthConfig", () => {
  it("refuses (does not fail open) when nothing is configured", async () => {
    const config = await resolveStudioAuthConfig({ root, env: {} });
    expect(config.mode).toBe("unconfigured");
  });

  it("reads env credentials and auto-generates a 0600 session secret that is stable", async () => {
    const config = await resolveStudioAuthConfig({ root, env: { INKOS_STUDIO_USER: "writer", INKOS_STUDIO_PASSWORD_HASH: hash } });
    expect(config).toMatchObject({ mode: "enabled", user: "writer", credentialSource: "env", sessionSecretSource: "generated", cookieSecure: true });
    const file = join(root, ".inkos", SESSION_SECRET_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const again = await resolveStudioAuthConfig({ root, env: { INKOS_STUDIO_USER: "writer", INKOS_STUDIO_PASSWORD_HASH: hash } });
    expect(again).toMatchObject({ sessionSecretSource: "file" });
    if (config.mode === "enabled" && again.mode === "enabled") expect(again.sessionSecret).toBe(config.sessionSecret);
    expect((await readFile(file, "utf8")).trim().length).toBeGreaterThanOrEqual(32);
  });

  it("falls back to secrets.json studioAuth; env wins over secrets.json", async () => {
    await writeSecrets({ services: {}, studioAuth: { user: "fromfile", passwordHash: hash, sessionSecret: "s".repeat(40) } });
    const fromFile = await resolveStudioAuthConfig({ root, env: {} });
    expect(fromFile).toMatchObject({ mode: "enabled", user: "fromfile", credentialSource: "secrets.json", sessionSecretSource: "secrets.json" });
    const fromEnv = await resolveStudioAuthConfig({
      root,
      env: { INKOS_STUDIO_USER: "fromenv", INKOS_STUDIO_PASSWORD_HASH: hash, INKOS_STUDIO_SESSION_SECRET: "e".repeat(40) },
    });
    expect(fromEnv).toMatchObject({ mode: "enabled", user: "fromenv", credentialSource: "env", sessionSecretSource: "env" });
  });

  it("rejects a plaintext password in the hash field and half-configured env", async () => {
    const plain = await resolveStudioAuthConfig({ root, env: { INKOS_STUDIO_USER: "writer", INKOS_STUDIO_PASSWORD_HASH: "hunter2-plaintext" } });
    expect(plain.mode).toBe("unconfigured");
    const half = await resolveStudioAuthConfig({ root, env: { INKOS_STUDIO_USER: "writer" } });
    expect(half.mode).toBe("unconfigured");
    const withPlainVar = await resolveStudioAuthConfig({ root, env: { INKOS_STUDIO_PASSWORD: "x" } });
    expect(withPlainVar.mode).toBe("unconfigured");
    expect(withPlainVar.warnings.join("\n")).toContain("INKOS_STUDIO_PASSWORD");
  });

  it("explicit INKOS_STUDIO_AUTH=off disables login with a danger warning; junk values refuse", async () => {
    const off = await resolveStudioAuthConfig({ root, env: { INKOS_STUDIO_AUTH: "off" } });
    expect(off.mode).toBe("disabled");
    expect(off.warnings.join("\n")).toContain("INKOS_STUDIO_AUTH=off");
    expect((await resolveStudioAuthConfig({ root, env: { INKOS_STUDIO_AUTH: "false" } })).mode).toBe("unconfigured");
  });

  it("parses cookie-secure override, trusted proxies and short secrets", async () => {
    const env = { INKOS_STUDIO_USER: "writer", INKOS_STUDIO_PASSWORD_HASH: hash };
    const insecure = await resolveStudioAuthConfig({ root, env: { ...env, INKOS_STUDIO_COOKIE_SECURE: "0", INKOS_TRUSTED_PROXIES: "172.16.0.0/12" } });
    expect(insecure).toMatchObject({ mode: "enabled", cookieSecure: false });
    if (insecure.mode === "enabled") expect(insecure.trustedProxies.contains("172.18.0.1")).toBe(true);
    expect((await resolveStudioAuthConfig({ root, env: { ...env, INKOS_TRUSTED_PROXIES: "nope" } })).mode).toBe("unconfigured");
    expect((await resolveStudioAuthConfig({ root, env: { ...env, INKOS_STUDIO_SESSION_SECRET: "short" } })).mode).toBe("unconfigured");
  });
});
