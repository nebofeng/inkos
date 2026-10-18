import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStudioServer } from "../api/server.js";
import { createStudioAuthRuntime } from "../api/auth/index.js";
import { hashPassword } from "../api/auth/password.js";

// Fake values only — never real keys.
const FAKE_LLM_KEY = "sk-fake-rd016-llm-0000-k9q2";
const FAKE_COVER_KEY = "sk-fake-rd016-cover-0000-c7x1";
const FAKE_SEARCH_KEY = "tvly-fake-rd016-0000-s5m8";

describe("Studio key masking + login gate (real core)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-auth-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "auth-fixture",
      version: "0.1.0",
      language: "zh",
      llm: { provider: "openai", baseUrl: "http://127.0.0.1:9/v1", model: "fake-model" },
      researchSearch: { enabled: true, provider: "tavily", apiKey: FAKE_SEARCH_KEY },
    }, null, 2));
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, ".inkos", "secrets.json"), JSON.stringify({
      services: { openai: { apiKey: FAKE_LLM_KEY }, "cover:kkaiapi": { apiKey: FAKE_COVER_KEY } },
    }));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("never returns full keys from secret / cover / research-search endpoints", async () => {
    const app = createStudioServer({} as never, root);
    for (const [path, tail] of [
      ["/api/v1/services/openai/secret", "k9q2"],
      ["/api/v1/cover/secret/kkaiapi", "c7x1"],
      ["/api/v1/project/research-search", "s5m8"],
    ] as const) {
      const res = await app.request(path);
      const text = await res.text();
      expect(res.status, path).toBe(200);
      expect(text).toContain(`****${tail}`);
      for (const key of [FAKE_LLM_KEY, FAKE_COVER_KEY, FAKE_SEARCH_KEY]) expect(text).not.toContain(key);
    }
  });

  it("saving masked values back keeps the stored keys", async () => {
    const app = createStudioServer({} as never, root);
    expect((await app.request("/api/v1/cover/secret/kkaiapi", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "****c7x1" }),
    })).status).toBe(200);
    expect((await app.request("/api/v1/project/research-search", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ researchSearch: { enabled: true, provider: "tavily", apiKey: "****s5m8" } }),
    })).status).toBe(200);
    expect((await app.request("/api/v1/services/openai/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "****k9q2" }),
    })).status).toBe(200);

    const secrets = JSON.parse(await readFile(join(root, ".inkos", "secrets.json"), "utf8"));
    expect(secrets.services.openai.apiKey).toBe(FAKE_LLM_KEY);
    expect(secrets.services["cover:kkaiapi"].apiKey).toBe(FAKE_COVER_KEY);
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf8"));
    expect(raw.researchSearch.apiKey).toBe(FAKE_SEARCH_KEY);
  });

  it("secrets.json studioAuth survives a service-key save from the UI", async () => {
    const hash = await hashPassword("fake-studio-pass", { N: 1024 });
    await writeFile(join(root, ".inkos", "secrets.json"), JSON.stringify({
      services: { openai: { apiKey: FAKE_LLM_KEY } },
      studioAuth: { user: "writer", passwordHash: hash },
    }));
    const auth = await createStudioAuthRuntime({ root, env: {}, log: () => undefined });
    expect(auth.config.mode).toBe("enabled");
    const app = createStudioServer({} as never, root, { auth });
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "writer", password: "fake-studio-pass" }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const save = await app.request("/api/v1/services/deepseek/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ apiKey: "sk-fake-rd016-deepseek-0000" }),
    });
    expect(save.status).toBe(200);
    const secrets = JSON.parse(await readFile(join(root, ".inkos", "secrets.json"), "utf8"));
    expect(secrets.studioAuth).toEqual({ user: "writer", passwordHash: hash });
    expect(secrets.services.deepseek.apiKey).toBe("sk-fake-rd016-deepseek-0000");
  });
});
