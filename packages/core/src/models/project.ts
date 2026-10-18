import { z } from "zod";

// C1 (v2.0.0 breaking): `maxTokens` 字段已被 providers bank 接管；zod 用 strip mode 静默丢弃老配置里的 `maxTokens`。
const LLMServiceEntrySchema = z.object({
  service: z.string().min(1),
  name: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  models: z.array(z.string().min(1)).optional(),
  /** Optional per-model context windows keyed by model id (manual fill). */
  modelContextWindows: z.record(z.string(), z.number().int().min(1)).optional(),
  temperature: z.number().min(0).max(2).optional(),
  apiFormat: z.enum(["chat", "responses"]).optional(),
  stream: z.boolean().optional(),
});

const LLMCoverConfigSchema = z.object({
  service: z.enum(["kkaiapi", "openai", "google"]),
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
}).optional();

// C1 (v2.0.0 breaking): 删除 maxTokens / maxTokensCap 字段。
// 每个模型的真实 maxOutput 来自 providers/<name>.ts 的 InkosModel.maxOutput；
// 老配置里写的 maxTokens / maxTokensCap 会被 zod strip 静默丢弃（不报错）。
export const LLMConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "custom"]),
  service: z.string().default("custom"),
  configSource: z.enum(["env", "studio"]).default("env"),
  baseUrl: z.string().url(),
  apiKey: z.string().default(""),
  model: z.string().min(1),
  proxyUrl: z.string().url().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  thinkingBudget: z.number().int().min(0).default(0),
  extra: z.record(z.unknown()).optional(),
  headers: z.record(z.string()).optional(),
  apiFormat: z.enum(["chat", "responses"]).default("chat"),
  stream: z.boolean().default(true),
  /** Manual override for the selected model's context window (tokens). */
  contextWindow: z.number().int().min(1).optional(),
  // Transient gateway errors (429/502/503/504): retry count and per-retry delay.
  retry: z.object({
    maxRetries: z.number().int().min(0).max(10).optional(),
    backoffMs: z.array(z.number().int().min(0)).min(1).optional(),
  }).optional(),
  services: z.array(LLMServiceEntrySchema).optional(),
  defaultModel: z.string().min(1).optional(),
  cover: LLMCoverConfigSchema,
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

export const NotifyChannelSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("telegram"),
    botToken: z.string().min(1),
    chatId: z.string().min(1),
    format: z.enum(["markdown", "text"]).default("markdown"),
  }),
  z.object({
    type: z.literal("wechat-work"),
    webhookUrl: z.string().url(),
    format: z.enum(["markdown", "text"]).default("markdown"),
  }),
  z.object({
    type: z.literal("feishu"),
    webhookUrl: z.string().url(),
    format: z.enum(["markdown", "text"]).default("markdown"),
  }),
  z.object({
    type: z.literal("webhook"),
    url: z.string().url(),
    secret: z.string().optional(),
    events: z.array(z.string()).default([]),
    format: z.enum(["markdown", "text"]).default("markdown"),
  }),
]);

export type NotifyChannel = z.infer<typeof NotifyChannelSchema>;

export const DetectionConfigSchema = z.object({
  provider: z.enum(["gptzero", "originality", "custom"]).default("custom"),
  apiUrl: z.string().url(),
  apiKeyEnv: z.string().min(1),
  threshold: z.number().min(0).max(1).default(0.5),
  enabled: z.boolean().default(false),
  autoRewrite: z.boolean().default(false),
  maxRetries: z.number().int().min(1).max(10).default(3),
});

export type DetectionConfig = z.infer<typeof DetectionConfigSchema>;

/**
 * Post-write semantic cleanup (inkos-story-deslop).
 * Default on once wired. Production should use the novel/writing LLM channel
 * (`AGENT_KEY_PURPOSE=novel`), not the DEV coding key.
 */
export const DeslopConfigSchema = z.object({
  enabled: z.boolean().default(true),
  keepOriginal: z.boolean().default(true),
  maxRetries: z.number().int().min(1).max(10).default(2),
  mode: z.enum(["local", "full"]).default("local"),
});

export type DeslopConfig = z.infer<typeof DeslopConfigSchema>;

export const DEFAULT_DESLOP_CONFIG: DeslopConfig = {
  enabled: true,
  keepOriginal: true,
  maxRetries: 2,
  mode: "local",
};

export const OpeningCheckConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

export type OpeningCheckConfig = z.infer<typeof OpeningCheckConfigSchema>;

export const DEFAULT_OPENING_CHECK_CONFIG: OpeningCheckConfig = {
  enabled: true,
};

/**
 * Post-write quality gate (AI-flavor score + word-count floor).
 * Distinct from daemon.qualityGates (audit retry / consecutive-failure pause).
 */
export const QualityGateOnFailSchema = z.enum(["warn", "retry", "pause"]);
export type QualityGateOnFail = z.infer<typeof QualityGateOnFailSchema>;

export const QualityGateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Left optional so platformPreset defaults (e.g. zhihu-short=55) can apply. */
  aiFlavorThreshold: z.number().min(0).max(100).optional(),
  minWordRatio: z.number().min(0).max(1).default(0.7),
  maxRetries: z.number().int().min(0).max(10).default(1),
  onFail: QualityGateOnFailSchema.default("warn"),
});

export type QualityGateConfig = z.infer<typeof QualityGateConfigSchema>;

export const DEFAULT_QUALITY_GATE_CONFIG: QualityGateConfig = {
  enabled: true,
  minWordRatio: 0.7,
  maxRetries: 1,
  onFail: "warn",
};

export const BookQualityGateOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  aiFlavorThreshold: z.number().min(0).max(100).optional(),
  minWordRatio: z.number().min(0).max(1).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  onFail: QualityGateOnFailSchema.optional(),
});

export type BookQualityGateOverride = z.infer<typeof BookQualityGateOverrideSchema>;

export const QualityGatesSchema = z.object({
  maxAuditRetries: z.number().int().min(0).max(10).default(2),
  pauseAfterConsecutiveFailures: z.number().int().min(1).default(3),
  retryTemperatureStep: z.number().min(0).max(0.5).default(0.1),
});

export type QualityGates = z.infer<typeof QualityGatesSchema>;

export const FoundationConfigSchema = z.object({
  reviewRetries: z.number().int().min(0).max(10).default(2),
});

export type FoundationConfig = z.infer<typeof FoundationConfigSchema>;

export const WritingConfigSchema = z.object({
  reviewRetries: z.number().int().min(0).max(10).default(1),
  reviewMode: z.enum(["auto", "manual"]).default("auto"),
  revisionGate: z.enum(["strict", "lenient", "always"]).default("strict"),
});

export type WritingConfig = z.infer<typeof WritingConfigSchema>;

export const AgentLLMOverrideSchema = z.object({
  model: z.string().min(1),
  service: z.string().min(1).optional(),
  provider: z.enum(["anthropic", "openai", "custom"]).optional(),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().optional(),
  stream: z.boolean().optional(),
});

export type AgentLLMOverride = z.infer<typeof AgentLLMOverrideSchema>;

const ModelOverrideValueSchema = z.union([z.string(), AgentLLMOverrideSchema]);

export const ResearchSearchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["tavily", "custom"]).default("tavily"),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
}).default({
  enabled: false,
  provider: "tavily",
});

export type ResearchSearchConfig = z.infer<typeof ResearchSearchConfigSchema>;

export const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  version: z.literal("0.1.0"),
  language: z.enum(["zh", "en"]).default("zh"),
  llm: LLMConfigSchema,
  notify: z.array(NotifyChannelSchema).default([]),
  detection: DetectionConfigSchema.optional(),
  deslop: DeslopConfigSchema.default({
    enabled: true,
    keepOriginal: true,
    maxRetries: 2,
    mode: "local",
  }),
  openingCheck: OpeningCheckConfigSchema.default({
    enabled: true,
  }),
  /** Writing-platform preset id (qidian/fanqie/jjwxc/qimao/zhihu-short). Distinct from book.platform. */
  platformPreset: z.string().min(1).optional(),
  qualityGate: QualityGateConfigSchema.default({
    enabled: true,
    minWordRatio: 0.7,
    maxRetries: 1,
    onFail: "warn",
  }),
  foundation: FoundationConfigSchema.default({
    reviewRetries: 2,
  }),
  writing: WritingConfigSchema.default({
    reviewRetries: 1,
  }),
  researchSearch: ResearchSearchConfigSchema,
  context: z.object({
    profile: z.enum(["default", "longform-rag"]).default("default"),
    windowCapTokens: z.number().int().min(8_000).max(2_000_000).default(128_000),
    autoConsolidateOnGuard: z.boolean().default(true),
    maxGuardRetries: z.number().int().min(0).max(5).default(2),
    predictiveThreshold: z.number().min(0.5).max(1).default(0.85),
  }).default({
    profile: "default",
    windowCapTokens: 128_000,
    autoConsolidateOnGuard: true,
    maxGuardRetries: 2,
    predictiveThreshold: 0.85,
  }),
  memory: z.object({
    graph: z.object({
      enabled: z.boolean().optional(),
      budgetTokens: z.number().int().optional(),
      hops: z.union([z.literal(1), z.literal(2)]).optional(),
    }).optional(),
  }).optional(),
  modelOverrides: z.record(z.string(), ModelOverrideValueSchema).optional(),
  daemon: z.object({
    schedule: z.object({
      radarCron: z.string().default("0 */6 * * *"),
      writeCron: z.string().default("*/15 * * * *"),
    }),
    maxConcurrentBooks: z.number().int().min(1).default(3),
    chaptersPerCycle: z.number().int().min(1).max(20).default(1),
    retryDelayMs: z.number().int().min(0).default(30_000),
    cooldownAfterChapterMs: z.number().int().min(0).default(10_000),
    maxChaptersPerDay: z.number().int().min(1).default(50),
    qualityGates: QualityGatesSchema.default({
      maxAuditRetries: 2,
      pauseAfterConsecutiveFailures: 3,
      retryTemperatureStep: 0.1,
    }),
  }).default({
    schedule: {
      radarCron: "0 */6 * * *",
      writeCron: "*/15 * * * *",
    },
    maxConcurrentBooks: 3,
    chaptersPerCycle: 1,
    retryDelayMs: 30_000,
    cooldownAfterChapterMs: 10_000,
    maxChaptersPerDay: 50,
    qualityGates: {
      maxAuditRetries: 2,
      pauseAfterConsecutiveFailures: 3,
      retryTemperatureStep: 0.1,
    },
  }),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
