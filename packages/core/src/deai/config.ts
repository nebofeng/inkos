/**
 * deAI config resolver (RD-038).
 *
 * Field-level precedence (high → low):
 *   explicit overrides (CLI/API)
 *   > book.deAI
 *   > book.qualityGate (legacy)
 *   > project.deAI
 *   > project.qualityGate / project.deslop / project.detection (legacy)
 *   > platform preset (aiFlavorThreshold only)
 *   > code defaults
 *
 * Enabled semantics (preserve today's two independent switches):
 *   - rewriteEnabled ← deslop.enabled (default true) — post-write deslop rewrite
 *   - gateEnabled    ← qualityGate.enabled (default true) — AI-flavor / word-count gate
 *   When `deAI.enabled` is set it applies to BOTH flags (unified pipeline).
 *   Un-migrated configs leave deAI.enabled unset, so the two flags stay independent.
 *
 * Legacy key removal: do not drop `deslop` / `qualityGate` / `detection` from
 * schema earlier than 2 minor releases after RD-038.
 */

import type { BookConfig } from "../models/book.js";
import type {
  BookDeAIOverride,
  BookQualityGateOverride,
  DeslopConfig,
  DetectionConfig,
  ProjectConfig,
  ProjectDeAIConfig,
  QualityGateConfig,
  QualityGateOnFail,
} from "../models/project.js";
import { resolvePlatformPreset } from "../platform-presets/resolve.js";
import { createLogger, createStderrSink, type Logger } from "../utils/logger.js";

export const DEFAULT_AI_FLAVOR_THRESHOLD = 60;
export const DEFAULT_DEAI_SKILL = "inkos-story-deslop";
export const FULL_DEAI_SKILL = "inkos-story-deslop-full";
export const DEFAULT_DEAI_MAX_RETRIES = 1;
export const DEFAULT_DEAI_MIN_WORD_RATIO = 0.7;
export const DEFAULT_DEAI_ON_FAIL: QualityGateOnFail = "warn";
export const DEFAULT_REWRITE_CALL_RETRIES = 2;
export const DEFAULT_EXTERNAL_DETECT_ENABLED = false;
export const DEFAULT_EXTERNAL_DETECT_AUTO_REWRITE = false;
export const DEFAULT_EXTERNAL_DETECT_MAX_RETRIES = 3;
export const DEFAULT_EXTERNAL_DETECT_THRESHOLD = 0.5;

const LEGACY_DEPRECATION_MESSAGE =
  "legacy deslop / qualityGate / detection config keys are deprecated; migrate to `deAI`. " +
  "Removal target: no earlier than 2 minor releases after RD-038.";

let deprecationWarned = false;
let defaultLogger: Logger | undefined;

export function resetDeAIDeprecationWarningForTests(): void {
  deprecationWarned = false;
}

export function deAIDeprecationWarningEmitted(): boolean {
  return deprecationWarned;
}

export type DeAISkillId = string;

export interface EffectiveExternalDetectConfig {
  readonly enabled: boolean;
  readonly autoRewrite: boolean;
  readonly maxRetries: number;
  readonly provider?: DetectionConfig["provider"];
  readonly apiUrl?: string;
  readonly apiKeyEnv?: string;
  readonly threshold: number;
}

export interface EffectiveDeAIConfig {
  /** Unified rewrite switch (deslop.enabled / deAI.enabled). */
  readonly enabled: boolean;
  readonly rewriteEnabled: boolean;
  readonly gateEnabled: boolean;
  readonly skill: DeAISkillId;
  readonly aiFlavorThreshold: number;
  readonly minWordRatio: number;
  readonly maxRetries: number;
  readonly onFail: QualityGateOnFail;
  readonly keepOriginal: boolean;
  readonly rewriteCallRetries: number;
  readonly externalDetect: EffectiveExternalDetectConfig;
}

export type DeAIConfigSource =
  | "overrides"
  | "book.deAI"
  | "book.qualityGate"
  | "project.deAI"
  | "project.qualityGate"
  | "project.deslop"
  | "project.detection"
  | "preset"
  | "default";

export type DeAIConfigField =
  | "enabled"
  | "rewriteEnabled"
  | "gateEnabled"
  | "skill"
  | "aiFlavorThreshold"
  | "minWordRatio"
  | "maxRetries"
  | "onFail"
  | "keepOriginal"
  | "rewriteCallRetries"
  | "externalDetect.enabled"
  | "externalDetect.autoRewrite"
  | "externalDetect.maxRetries"
  | "externalDetect.provider"
  | "externalDetect.apiUrl"
  | "externalDetect.apiKeyEnv"
  | "externalDetect.threshold";

export type DeAIConfigSources = Record<DeAIConfigField, DeAIConfigSource>;

export interface DeAIConfigOverrides {
  readonly enabled?: boolean;
  readonly skill?: string;
  readonly aiFlavorThreshold?: number | null;
  readonly minWordRatio?: number;
  readonly maxRetries?: number;
  readonly onFail?: QualityGateOnFail;
  readonly keepOriginal?: boolean;
  readonly rewriteCallRetries?: number;
  readonly externalDetect?: Partial<EffectiveExternalDetectConfig> | null;
}

export interface ResolveDeAIProjectInput {
  readonly deAI?: ProjectDeAIConfig | null;
  readonly deslop?: Partial<DeslopConfig> | null;
  readonly qualityGate?: Partial<QualityGateConfig> | null;
  readonly detection?: Partial<DetectionConfig> | null;
  readonly platformPreset?: string | null;
}

export interface ResolveDeAIBookInput {
  readonly deAI?: BookDeAIOverride | null;
  readonly qualityGate?: BookQualityGateOverride | Partial<QualityGateConfig> | null;
}

export interface ResolveDeAIConfigInput {
  readonly project?: ResolveDeAIProjectInput | ProjectConfig | null;
  readonly book?: ResolveDeAIBookInput | BookConfig | null;
  readonly preset?: string | null;
  readonly overrides?: DeAIConfigOverrides | null;
  readonly logger?: Logger;
  /** Existing quality-gate callers should not trip the once-per-process deprecation. */
  readonly emitDeprecation?: boolean;
}

export interface ResolveDeAIConfigResult {
  readonly config: EffectiveDeAIConfig;
  readonly sources: DeAIConfigSources;
  readonly warnings: readonly string[];
}

type Candidate<T> = {
  readonly value: T | undefined;
  readonly source: DeAIConfigSource;
  readonly path: string;
  readonly kind: "deai" | "legacy" | "override" | "preset" | "default";
};

function hasOwn<T extends object>(obj: T | null | undefined, key: keyof T): boolean {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

function defined<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

function skillFromDeslopMode(mode: DeslopConfig["mode"] | undefined): string | undefined {
  if (mode === "full") return FULL_DEAI_SKILL;
  if (mode === "local") return DEFAULT_DEAI_SKILL;
  return undefined;
}

function pick<T>(
  candidates: ReadonlyArray<Candidate<T>>,
  fallback: T,
  fallbackSource: DeAIConfigSource = "default",
): {
  value: T;
  source: DeAIConfigSource;
  kind: Candidate<T>["kind"] | "default";
  deaiPath?: string;
  legacyPath?: string;
} {
  let deaiPath: string | undefined;
  let legacyPath: string | undefined;
  for (const candidate of candidates) {
    if (candidate.kind === "deai" && candidate.value !== undefined && deaiPath === undefined) {
      deaiPath = candidate.path;
    }
    if (candidate.kind === "legacy" && candidate.value !== undefined && legacyPath === undefined) {
      legacyPath = candidate.path;
    }
  }
  for (const candidate of candidates) {
    if (candidate.value !== undefined) {
      return {
        value: candidate.value,
        source: candidate.source,
        kind: candidate.kind,
        deaiPath,
        legacyPath,
      };
    }
  }
  return { value: fallback, source: fallbackSource, kind: "default", deaiPath, legacyPath };
}

function conflictWarning(legacyPath: string, deaiPath: string): string {
  return `忽略 \`${legacyPath}\`，使用 \`${deaiPath}\``;
}

function maybeConflict(
  warnings: string[],
  picked: { kind: string; deaiPath?: string; legacyPath?: string },
): void {
  // deAI wins over a same-field legacy key → name both. If a higher-priority
  // legacy key won (e.g. book.qualityGate over project.deAI), do not claim deAI won.
  if ((picked.kind === "deai" || picked.kind === "override") && picked.deaiPath && picked.legacyPath) {
    warnings.push(conflictWarning(picked.legacyPath, picked.deaiPath));
  }
}

function getDefaultLogger(): Logger {
  if (!defaultLogger) {
    defaultLogger = createLogger({
      tag: "deAI",
      sinks: [createStderrSink({ minLevel: "warn" })],
    });
  }
  return defaultLogger;
}

function emitLegacyDeprecation(logger: Logger | undefined): void {
  if (deprecationWarned) return;
  deprecationWarned = true;
  const log = logger ?? getDefaultLogger();
  log.warn(LEGACY_DEPRECATION_MESSAGE);
}

function hasLegacyKeys(
  project: ResolveDeAIProjectInput | null | undefined,
  book: ResolveDeAIBookInput | null | undefined,
): boolean {
  return Boolean(
    (project && (hasOwn(project, "deslop") || hasOwn(project, "qualityGate") || hasOwn(project, "detection")))
    || (book && hasOwn(book, "qualityGate")),
  );
}

/**
 * Resolve the effective deAI config. Defaults are applied here, not in Zod.
 */
export function resolveDeAIConfig(input: ResolveDeAIConfigInput = {}): ResolveDeAIConfigResult {
  const project = input.project ?? undefined;
  const book = input.book ?? undefined;
  const overrides = input.overrides ?? undefined;
  const projectDeAI = project?.deAI ?? undefined;
  const bookDeAI = book?.deAI ?? undefined;
  const projectQg = project?.qualityGate ?? undefined;
  const bookQg = book?.qualityGate ?? undefined;
  const deslop = project?.deslop ?? undefined;
  const detection = project?.detection ?? undefined;
  const extOver = overrides?.externalDetect ?? undefined;
  const extDeAI = projectDeAI?.externalDetect ?? undefined;
  const warnings: string[] = [];

  const presetId = input.preset ?? project?.platformPreset ?? undefined;
  const preset = resolvePlatformPreset(presetId);

  const rewrite = pick<boolean>([
    { value: overrides?.enabled, source: "overrides", path: "overrides.enabled", kind: "override" },
    { value: bookDeAI?.enabled, source: "book.deAI", path: "book.deAI.enabled", kind: "deai" },
    { value: projectDeAI?.enabled, source: "project.deAI", path: "deAI.enabled", kind: "deai" },
    { value: deslop?.enabled, source: "project.deslop", path: "deslop.enabled", kind: "legacy" },
  ], true);
  maybeConflict(warnings, rewrite);

  const gate = pick<boolean>([
    { value: overrides?.enabled, source: "overrides", path: "overrides.enabled", kind: "override" },
    { value: bookDeAI?.enabled, source: "book.deAI", path: "book.deAI.enabled", kind: "deai" },
    { value: bookQg?.enabled, source: "book.qualityGate", path: "book.qualityGate.enabled", kind: "legacy" },
    { value: projectDeAI?.enabled, source: "project.deAI", path: "deAI.enabled", kind: "deai" },
    { value: projectQg?.enabled, source: "project.qualityGate", path: "qualityGate.enabled", kind: "legacy" },
  ], true);
  maybeConflict(warnings, gate);

  const skill = pick<string>([
    { value: overrides?.skill, source: "overrides", path: "overrides.skill", kind: "override" },
    { value: bookDeAI?.skill, source: "book.deAI", path: "book.deAI.skill", kind: "deai" },
    { value: projectDeAI?.skill, source: "project.deAI", path: "deAI.skill", kind: "deai" },
    { value: skillFromDeslopMode(deslop?.mode), source: "project.deslop", path: "deslop.mode", kind: "legacy" },
  ], DEFAULT_DEAI_SKILL);
  maybeConflict(warnings, skill);

  const threshold = pick<number>([
    { value: defined(overrides?.aiFlavorThreshold) ? overrides.aiFlavorThreshold : undefined, source: "overrides", path: "overrides.aiFlavorThreshold", kind: "override" },
    { value: defined(bookDeAI?.aiFlavorThreshold) ? bookDeAI.aiFlavorThreshold : undefined, source: "book.deAI", path: "book.deAI.aiFlavorThreshold", kind: "deai" },
    { value: bookQg?.aiFlavorThreshold, source: "book.qualityGate", path: "book.qualityGate.aiFlavorThreshold", kind: "legacy" },
    { value: defined(projectDeAI?.aiFlavorThreshold) ? projectDeAI.aiFlavorThreshold : undefined, source: "project.deAI", path: "deAI.aiFlavorThreshold", kind: "deai" },
    { value: projectQg?.aiFlavorThreshold, source: "project.qualityGate", path: "qualityGate.aiFlavorThreshold", kind: "legacy" },
    { value: preset?.aiFlavorThreshold, source: "preset", path: "preset.aiFlavorThreshold", kind: "preset" },
  ], DEFAULT_AI_FLAVOR_THRESHOLD, preset?.aiFlavorThreshold != null ? "preset" : "default");
  maybeConflict(warnings, threshold);

  const minWordRatio = pick<number>([
    { value: overrides?.minWordRatio, source: "overrides", path: "overrides.minWordRatio", kind: "override" },
    { value: bookDeAI?.minWordRatio, source: "book.deAI", path: "book.deAI.minWordRatio", kind: "deai" },
    { value: bookQg?.minWordRatio, source: "book.qualityGate", path: "book.qualityGate.minWordRatio", kind: "legacy" },
    { value: projectDeAI?.minWordRatio, source: "project.deAI", path: "deAI.minWordRatio", kind: "deai" },
    { value: projectQg?.minWordRatio, source: "project.qualityGate", path: "qualityGate.minWordRatio", kind: "legacy" },
  ], DEFAULT_DEAI_MIN_WORD_RATIO);
  maybeConflict(warnings, minWordRatio);

  const maxRetries = pick<number>([
    { value: overrides?.maxRetries, source: "overrides", path: "overrides.maxRetries", kind: "override" },
    { value: bookDeAI?.maxRetries, source: "book.deAI", path: "book.deAI.maxRetries", kind: "deai" },
    { value: bookQg?.maxRetries, source: "book.qualityGate", path: "book.qualityGate.maxRetries", kind: "legacy" },
    { value: projectDeAI?.maxRetries, source: "project.deAI", path: "deAI.maxRetries", kind: "deai" },
    { value: projectQg?.maxRetries, source: "project.qualityGate", path: "qualityGate.maxRetries", kind: "legacy" },
  ], DEFAULT_DEAI_MAX_RETRIES);
  maybeConflict(warnings, maxRetries);

  const onFail = pick<QualityGateOnFail>([
    { value: overrides?.onFail, source: "overrides", path: "overrides.onFail", kind: "override" },
    { value: bookDeAI?.onFail, source: "book.deAI", path: "book.deAI.onFail", kind: "deai" },
    { value: bookQg?.onFail, source: "book.qualityGate", path: "book.qualityGate.onFail", kind: "legacy" },
    { value: projectDeAI?.onFail, source: "project.deAI", path: "deAI.onFail", kind: "deai" },
    { value: projectQg?.onFail, source: "project.qualityGate", path: "qualityGate.onFail", kind: "legacy" },
  ], DEFAULT_DEAI_ON_FAIL);
  maybeConflict(warnings, onFail);

  const keepOriginal = pick<boolean>([
    { value: overrides?.keepOriginal, source: "overrides", path: "overrides.keepOriginal", kind: "override" },
    { value: projectDeAI?.keepOriginal, source: "project.deAI", path: "deAI.keepOriginal", kind: "deai" },
    { value: deslop?.keepOriginal, source: "project.deslop", path: "deslop.keepOriginal", kind: "legacy" },
  ], true);
  maybeConflict(warnings, keepOriginal);

  const rewriteCallRetries = pick<number>([
    { value: overrides?.rewriteCallRetries, source: "overrides", path: "overrides.rewriteCallRetries", kind: "override" },
    { value: projectDeAI?.rewriteCallRetries, source: "project.deAI", path: "deAI.rewriteCallRetries", kind: "deai" },
    { value: deslop?.maxRetries, source: "project.deslop", path: "deslop.maxRetries", kind: "legacy" },
  ], DEFAULT_REWRITE_CALL_RETRIES);
  maybeConflict(warnings, rewriteCallRetries);

  const extEnabled = pick<boolean>([
    { value: extOver?.enabled, source: "overrides", path: "overrides.externalDetect.enabled", kind: "override" },
    { value: extDeAI?.enabled, source: "project.deAI", path: "deAI.externalDetect.enabled", kind: "deai" },
    { value: detection?.enabled, source: "project.detection", path: "detection.enabled", kind: "legacy" },
  ], DEFAULT_EXTERNAL_DETECT_ENABLED);
  maybeConflict(warnings, extEnabled);

  const extAutoRewrite = pick<boolean>([
    { value: extOver?.autoRewrite, source: "overrides", path: "overrides.externalDetect.autoRewrite", kind: "override" },
    { value: extDeAI?.autoRewrite, source: "project.deAI", path: "deAI.externalDetect.autoRewrite", kind: "deai" },
    { value: detection?.autoRewrite, source: "project.detection", path: "detection.autoRewrite", kind: "legacy" },
  ], DEFAULT_EXTERNAL_DETECT_AUTO_REWRITE);
  maybeConflict(warnings, extAutoRewrite);

  const extMaxRetries = pick<number>([
    { value: extOver?.maxRetries, source: "overrides", path: "overrides.externalDetect.maxRetries", kind: "override" },
    { value: extDeAI?.maxRetries, source: "project.deAI", path: "deAI.externalDetect.maxRetries", kind: "deai" },
    { value: detection?.maxRetries, source: "project.detection", path: "detection.maxRetries", kind: "legacy" },
  ], DEFAULT_EXTERNAL_DETECT_MAX_RETRIES);
  maybeConflict(warnings, extMaxRetries);

  const extProvider = pick<DetectionConfig["provider"] | undefined>([
    { value: extOver?.provider, source: "overrides", path: "overrides.externalDetect.provider", kind: "override" },
    { value: extDeAI?.provider, source: "project.deAI", path: "deAI.externalDetect.provider", kind: "deai" },
    { value: detection?.provider, source: "project.detection", path: "detection.provider", kind: "legacy" },
  ], undefined);
  maybeConflict(warnings, extProvider);

  const extApiUrl = pick<string | undefined>([
    { value: extOver?.apiUrl, source: "overrides", path: "overrides.externalDetect.apiUrl", kind: "override" },
    { value: extDeAI?.apiUrl, source: "project.deAI", path: "deAI.externalDetect.apiUrl", kind: "deai" },
    { value: detection?.apiUrl, source: "project.detection", path: "detection.apiUrl", kind: "legacy" },
  ], undefined);
  maybeConflict(warnings, extApiUrl);

  const extApiKeyEnv = pick<string | undefined>([
    { value: extOver?.apiKeyEnv, source: "overrides", path: "overrides.externalDetect.apiKeyEnv", kind: "override" },
    { value: extDeAI?.apiKeyEnv, source: "project.deAI", path: "deAI.externalDetect.apiKeyEnv", kind: "deai" },
    { value: detection?.apiKeyEnv, source: "project.detection", path: "detection.apiKeyEnv", kind: "legacy" },
  ], undefined);
  maybeConflict(warnings, extApiKeyEnv);

  const extThreshold = pick<number>([
    { value: extOver?.threshold, source: "overrides", path: "overrides.externalDetect.threshold", kind: "override" },
    { value: extDeAI?.threshold, source: "project.deAI", path: "deAI.externalDetect.threshold", kind: "deai" },
    { value: detection?.threshold, source: "project.detection", path: "detection.threshold", kind: "legacy" },
  ], DEFAULT_EXTERNAL_DETECT_THRESHOLD);
  maybeConflict(warnings, extThreshold);

  if (input.emitDeprecation !== false && hasLegacyKeys(project, book)) {
    emitLegacyDeprecation(input.logger);
  }

  const rewriteEnabled = rewrite.value;
  const gateEnabled = gate.value;
  const sources: DeAIConfigSources = {
    enabled: rewrite.source,
    rewriteEnabled: rewrite.source,
    gateEnabled: gate.source,
    skill: skill.source,
    aiFlavorThreshold: threshold.source,
    minWordRatio: minWordRatio.source,
    maxRetries: maxRetries.source,
    onFail: onFail.source,
    keepOriginal: keepOriginal.source,
    rewriteCallRetries: rewriteCallRetries.source,
    "externalDetect.enabled": extEnabled.source,
    "externalDetect.autoRewrite": extAutoRewrite.source,
    "externalDetect.maxRetries": extMaxRetries.source,
    "externalDetect.provider": extProvider.source,
    "externalDetect.apiUrl": extApiUrl.source,
    "externalDetect.apiKeyEnv": extApiKeyEnv.source,
    "externalDetect.threshold": extThreshold.source,
  };

  return {
    config: {
      enabled: rewriteEnabled,
      rewriteEnabled,
      gateEnabled,
      skill: skill.value,
      aiFlavorThreshold: threshold.value,
      minWordRatio: minWordRatio.value,
      maxRetries: maxRetries.value,
      onFail: onFail.value,
      keepOriginal: keepOriginal.value,
      rewriteCallRetries: rewriteCallRetries.value,
      externalDetect: {
        enabled: extEnabled.value,
        autoRewrite: extAutoRewrite.value,
        maxRetries: extMaxRetries.value,
        provider: extProvider.value,
        apiUrl: extApiUrl.value,
        apiKeyEnv: extApiKeyEnv.value,
        threshold: extThreshold.value,
      },
    },
    sources,
    warnings,
  };
}
