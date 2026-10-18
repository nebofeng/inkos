import {
  DEFAULT_QUALITY_GATE_CONFIG,
  type QualityGateConfig,
  type QualityGateOnFail,
} from "../models/project.js";
import {
  DEFAULT_AI_FLAVOR_THRESHOLD,
  resolveDeAIConfig,
} from "../deai/config.js";

export { DEFAULT_QUALITY_GATE_CONFIG, DEFAULT_AI_FLAVOR_THRESHOLD };

export const DEFAULT_QUALITY_GATE_ON_FAIL: QualityGateOnFail = "warn";
export const DEFAULT_QUALITY_GATE_MAX_RETRIES = 1;

/**
 * Merge order for aiFlavorThreshold:
 *   explicit book/project qualityGate.aiFlavorThreshold
 *   > platformPreset default
 *   > 60
 *
 * Other fields: book.qualityGate > project.qualityGate > defaults.
 *
 * Delegates to `resolveDeAIConfig` so deAI / legacy mapping stay in one place.
 * emitDeprecation is off: existing quality-gate callers must not trip the
 * once-per-process deAI migration warning.
 */
export function resolveQualityGateConfig(
  project?: Partial<QualityGateConfig> | null,
  book?: Partial<QualityGateConfig> | null,
  platformPresetId?: string | null,
): QualityGateConfig {
  const { config } = resolveDeAIConfig({
    project: { qualityGate: project },
    book: { qualityGate: book },
    preset: platformPresetId,
    emitDeprecation: false,
  });
  return {
    enabled: config.gateEnabled,
    aiFlavorThreshold: config.aiFlavorThreshold,
    minWordRatio: config.minWordRatio,
    maxRetries: config.maxRetries,
    onFail: config.onFail,
  };
}
