import { afterEach, describe, expect, it } from "vitest";
import type { LLMConfig } from "../models/project.js";
import {
  assertServiceModelPair,
  DEAI_REWRITE_AGENT,
  OPENING_CHECK_AGENT,
  resolveAgentLLMConfig,
  resolveOverrideLLMConfigSync,
} from "../utils/agent-llm-binding.js";

const BASE: LLMConfig = {
  provider: "custom",
  service: "custom",
  configSource: "env",
  baseUrl: "https://base.example/v1",
  apiKey: "base-key",
  model: "base-model",
  temperature: 0.7,
  thinkingBudget: 0,
  apiFormat: "chat",
  stream: true,
  services: [
    {
      service: "sub2api",
      baseUrl: "https://sub2api.example/v1",
      models: ["grok"],
      apiFormat: "chat",
    },
  ],
};

describe("assertServiceModelPair", () => {
  it("PASS：models 含 model 时放行（大小写不敏感）", () => {
    expect(() => assertServiceModelPair("sub2api", "grok", ["grok"])).not.toThrow();
    expect(() => assertServiceModelPair("sub2api", "GROK", ["grok"])).not.toThrow();
  });

  it("FAIL：sub2api models=[grok] 配 gemini 时同步抛错", () => {
    expect(() => assertServiceModelPair("sub2api", "gemini", ["grok"])).toThrow(
      "模型 gemini 不属于服务 sub2api。请改用支持该模型的 service，或更换模型。",
    );
  });

  it("未给 models 列表时不校验、不猜渠道", () => {
    expect(() => assertServiceModelPair("sub2api", "gemini")).not.toThrow();
  });
});

describe("resolveOverrideLLMConfigSync", () => {
  afterEach(() => {
    delete process.env.TEST_SUB2API_KEY;
  });

  it("string override 只改 model", () => {
    const resolved = resolveOverrideLLMConfigSync({ base: BASE, override: "writer-model" });
    expect(resolved.model).toBe("writer-model");
    expect(resolved.service).toBe("custom");
    expect(resolved.baseUrl).toBe(BASE.baseUrl);
    expect(resolved.apiKey).toBe("base-key");
  });

  it("PASS：service entry models 含 override.model 时合并 service 配置", () => {
    process.env.TEST_SUB2API_KEY = "from-env";
    const resolved = resolveOverrideLLMConfigSync({
      base: BASE,
      override: {
        model: "grok",
        service: "sub2api",
        apiKeyEnv: "TEST_SUB2API_KEY",
      },
    });
    expect(resolved.service).toBe("sub2api");
    expect(resolved.model).toBe("grok");
    expect(resolved.baseUrl).toBe("https://sub2api.example/v1");
    expect(resolved.apiKey).toBe("from-env");
    expect(resolved.provider).toBe("openai");
  });

  it("FAIL：sub2api models=[grok] + gemini 同步抛错", () => {
    expect(() => resolveOverrideLLMConfigSync({
      base: BASE,
      override: { model: "gemini", service: "sub2api" },
    })).toThrow("模型 gemini 不属于服务 sub2api。请改用支持该模型的 service，或更换模型。");
  });

  it("object + baseUrl 无 service 时保持现有行为，不按模型名猜 service", () => {
    const resolved = resolveOverrideLLMConfigSync({
      base: BASE,
      override: {
        model: "gemini-2.5-flash",
        provider: "custom",
        baseUrl: "https://shared.example/v1",
      },
    });
    expect(resolved.model).toBe("gemini-2.5-flash");
    expect(resolved.service).toBe("custom");
    expect(resolved.baseUrl).toBe("https://shared.example/v1");
    expect(resolved.apiKey).toBe("base-key");
  });
});

describe("resolveAgentLLMConfig", () => {
  it("falls back to base when agent has no override", () => {
    const resolved = resolveAgentLLMConfig({
      base: BASE,
      modelOverrides: { writer: "writer-model" },
      agentName: OPENING_CHECK_AGENT,
    });
    expect(resolved.model).toBe(BASE.model);
    expect(resolved.service).toBe(BASE.service);
  });

  it("binds opening-check and deai-rewrite to explicit service+model", () => {
    const opening = resolveAgentLLMConfig({
      base: BASE,
      modelOverrides: {
        [OPENING_CHECK_AGENT]: { model: "grok", service: "sub2api" },
        [DEAI_REWRITE_AGENT]: "writer-model",
      },
      agentName: OPENING_CHECK_AGENT,
    });
    expect(opening.service).toBe("sub2api");
    expect(opening.model).toBe("grok");

    const deai = resolveAgentLLMConfig({
      base: BASE,
      modelOverrides: {
        [DEAI_REWRITE_AGENT]: "writer-model",
      },
      agentName: DEAI_REWRITE_AGENT,
    });
    expect(deai.model).toBe("writer-model");
    expect(deai.service).toBe("custom");
  });
});
