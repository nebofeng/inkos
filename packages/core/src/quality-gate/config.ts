import {
  DEFAULT_QUALITY_GATE_CONFIG,
  type QualityGateConfig,
  type QualityGateOnFail,
} from "../models/project.js";
import { resolvePlatformPreset } from "../platform-presets/resolve.js";

export { DEFAULT_QUALITY_GATE_CONFIG };

export const DEFAULT_QUALITY_GATE_ON_FAIL: QualityGateOnFail = "warn";
export const DEFAULT_QUALITY_GATE_MAX_RETRIES = 1;
export const DEFAULT_AI_FLAVOR_THRESHOLD = 60;

/**
 * Merge order for aiFlavorThreshold:
 *   explicit book/project qualityGate.aiFlavorThreshold
 *   > platformPreset default
 *   > 60
 *
 * Other fields: book.qualityGate > project.qualityGate > defaults.
 */
export function resolveQualityGateConfig(
  project?: Partial<QualityGateConfig> | null,
  book?: Partial<QualityGateConfig> | null,
  platformPresetId?: string | null,
): QualityGateConfig {
  const preset = resolvePlatformPreset(platformPresetId);
  const enabled = book?.enabled ?? project?.enabled ?? DEFAULT_QUALITY_GATE_CONFIG.enabled;
  const minWordRatio = book?.minWordRatio ?? project?.minWordRatio ?? DEFAULT_QUALITY_GATE_CONFIG.minWordRatio;
  const maxRetries = book?.maxRetries ?? project?.maxRetries ?? DEFAULT_QUALITY_GATE_CONFIG.maxRetries;
  const onFail = book?.onFail ?? project?.onFail ?? DEFAULT_QUALITY_GATE_CONFIG.onFail;
  const aiFlavorThreshold = book?.aiFlavorThreshold
    ?? project?.aiFlavorThreshold
    ?? preset?.aiFlavorThreshold
    ?? DEFAULT_AI_FLAVOR_THRESHOLD;
  return { enabled, aiFlavorThreshold, minWordRatio, maxRetries, onFail };
}
