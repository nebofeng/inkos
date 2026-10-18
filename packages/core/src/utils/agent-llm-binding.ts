import type { AgentLLMOverride, LLMConfig } from "../models/project.js";
import { getEndpoint } from "../llm/providers/index.js";
import { resolveServicePreset, resolveServiceProviderFamily } from "../llm/service-presets.js";

export function assertServiceModelPair(
  service: string,
  model: string,
  models?: readonly string[],
): void {
  if (!models) return;
  const needle = model.toLowerCase();
  if (models.some((item) => item.toLowerCase() === needle)) return;
  throw new Error(`模型 ${model} 不属于服务 ${service}。请改用支持该模型的 service，或更换模型。`);
}

export function resolveOverrideLLMConfigSync(args: {
  base: LLMConfig;
  override: string | AgentLLMOverride;
}): LLMConfig {
  const { base, override } = args;
  if (typeof override === "string") {
    return { ...base, model: override };
  }
  if (override.service) {
    return resolveServiceOverride(base, override);
  }

  return {
    ...base,
    model: override.model,
    ...(override.provider ? { provider: override.provider } : {}),
    ...(override.baseUrl ? { baseUrl: override.baseUrl } : {}),
    apiKey: resolveOverrideApiKey(base, override),
    stream: override.stream ?? base.stream,
  };
}

function resolveServiceOverride(base: LLMConfig, override: AgentLLMOverride): LLMConfig {
  const service = override.service!;
  const entry = base.services?.find((item) => item.service === service);
  const preset = resolveServicePreset(service);
  const endpoint = getEndpoint(service);
  const models = entry?.models
    ?? (endpoint && endpoint.models.length > 0
      ? endpoint.models.map((item) => item.id)
      : undefined);

  assertServiceModelPair(service, override.model, models);

  return {
    ...base,
    service,
    provider: override.provider ?? providerForService(service),
    baseUrl: override.baseUrl
      ?? entry?.baseUrl
      ?? preset?.baseUrl
      ?? endpoint?.baseUrl
      ?? base.baseUrl,
    apiKey: resolveOverrideApiKey(base, override),
    model: override.model,
    apiFormat: resolveServiceApiFormat(base, entry?.apiFormat, preset, endpoint),
    stream: override.stream
      ?? entry?.stream
      ?? endpoint?.transportDefaults?.stream
      ?? base.stream,
  };
}

function resolveOverrideApiKey(base: LLMConfig, override: AgentLLMOverride): string {
  if (!override.apiKeyEnv) return base.apiKey;
  return process.env[override.apiKeyEnv] ?? "";
}

function providerForService(service: string): LLMConfig["provider"] {
  if (service === "custom") return "custom";
  return resolveServiceProviderFamily(service) ?? "openai";
}

function resolveServiceApiFormat(
  base: LLMConfig,
  entryApiFormat: LLMConfig["apiFormat"] | undefined,
  preset: ReturnType<typeof resolveServicePreset>,
  endpoint: ReturnType<typeof getEndpoint>,
): LLMConfig["apiFormat"] {
  if (entryApiFormat) return entryApiFormat;
  if (endpoint?.transportDefaults?.apiFormat) return endpoint.transportDefaults.apiFormat;
  if (preset?.api.startsWith("openai-responses")) return "responses";
  if (preset || endpoint) return "chat";
  return base.apiFormat;
}

export const OPENING_CHECK_AGENT = "opening-check";
export const DEAI_REWRITE_AGENT = "deai-rewrite";

export function resolveAgentLLMConfig(args: {
  readonly base: LLMConfig;
  readonly modelOverrides?: Record<string, string | AgentLLMOverride>;
  readonly agentName: string;
}): LLMConfig {
  const override = args.modelOverrides?.[args.agentName];
  if (!override) return args.base;
  return resolveOverrideLLMConfigSync({ base: args.base, override });
}
