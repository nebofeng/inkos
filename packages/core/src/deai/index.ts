export {
  DEFAULT_AI_FLAVOR_THRESHOLD,
  DEFAULT_DEAI_MAX_RETRIES,
  DEFAULT_DEAI_MIN_WORD_RATIO,
  DEFAULT_DEAI_ON_FAIL,
  DEFAULT_DEAI_SKILL,
  DEFAULT_EXTERNAL_DETECT_AUTO_REWRITE,
  DEFAULT_EXTERNAL_DETECT_ENABLED,
  DEFAULT_EXTERNAL_DETECT_MAX_RETRIES,
  DEFAULT_EXTERNAL_DETECT_THRESHOLD,
  DEFAULT_REWRITE_CALL_RETRIES,
  ANTI_DETECT_SKILL,
  FULL_DEAI_SKILL,
  deAIDeprecationWarningEmitted,
  resetDeAIDeprecationWarningForTests,
  resolveDeAIConfig,
  type DeAIConfigField,
  type DeAIConfigOverrides,
  type DeAIConfigSource,
  type DeAIConfigSources,
  type DeAISkillId,
  type EffectiveDeAIConfig,
  type EffectiveExternalDetectConfig,
  type ResolveDeAIBookInput,
  type ResolveDeAIConfigInput,
  type ResolveDeAIConfigResult,
  type ResolveDeAIProjectInput,
} from "./config.js";

export { DeAIPauseError, isDeAIPauseError } from "./errors.js";
export { appendDeAIRecord, deAIJsonPath, readDeAIFile } from "./persist.js";
export { runDeAI } from "./run.js";
export {
  clampDeAIBatchConcurrency,
  deAIBackupDir,
  deAIBatchStatePath,
  deAIPreviewPath,
  estimateDeAIBatchCostUsd,
  listDeAIBackups,
  listExistingChapterNumbers,
  parseDeAIRange,
  rollbackDeAIBatch,
  runDeAIBatch,
  DEAI_BATCH_CONCURRENCY_DEFAULT,
  DEAI_BATCH_CONCURRENCY_MAX,
  DEAI_BATCH_REWRITE_TOKEN_MULTIPLIER,
  DEAI_BATCH_USD_PER_1K_TOKENS,
  type DeAIBatchChapterState,
  type DeAIBatchChapterStatus,
  type DeAIBatchInput,
  type DeAIBatchMode,
  type DeAIBatchProgress,
  type DeAIBatchReport,
  type DeAIBatchRow,
  type DeAIBatchStateFile,
} from "./batch.js";

export {
  createDeAISkill,
  getDeAISkill,
  listDeAISkills,
  parseDeAISkillMarkdown,
  resolveDeAISkill,
  rewritePromptsForDeAISkill,
  scanDeAISkillBans,
  validateDeAISkill,
  DEAI_SCORER_BUILTIN,
  DEAI_SKILL_KIND,
  MAX_BANNED_PATTERN_CHARS,
  type CreateDeAISkillInput,
  type DeAISkill,
  type DeAISkillError,
  type DeAISkillListItem,
  type DeAISkillLookupInput,
  type DeAISkillRecord,
  type DeAISkillSource,
  type ResolveDeAISkillResult,
  type ValidateDeAISkillResult,
} from "./skills.js";
export type {
  DeAIChapterRecord,
  DeAIExternalDetectFn,
  DeAIFile,
  DeAIInput,
  DeAIMode,
  DeAIResult,
  DeAIRewriteInput,
  DeAIRewriter,
  DeAIStatus,
} from "./types.js";

/**
 * S7 handoff (RD-035 phase2): after `writeFinalArtifacts` (`final/full.md`),
 * call `runDeAI` once on that markdown. Preset `zhihu-short` → threshold 55;
 * mode `"full"`; `onFail` default `"warn"` — do not block `review.json` /
 * `status.json`. Persist the record to `shorts/<id>/deai.json` (not
 * `story/deai.json`). Do not fork a second pipeline; do not edit
 * short-fiction-runner.ts in RD-038.
 */
