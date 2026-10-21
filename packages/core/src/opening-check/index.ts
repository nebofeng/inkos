export {
  OPENING_CHECK_ITEMS,
  OPENING_CHECK_ITEM_IDS,
  OPENING_CHECK_DISPLAY_ITEMS,
  OPENING_CHECK_OUTPUT_FORMAT,
  OPENING_HARD_GATE_IDS,
  openingCheckItemById,
  normalizeOpeningCheckItemId,
  type OpeningCheckItemDef,
  type OpeningCheckItemId,
  type OpeningHardGateId,
} from "./checklist.js";
export {
  collectHardGateBlocks,
  deriveHardGateItems,
  evaluateOpeningHardGate,
  formatOpeningHardGateFailure,
  hardGateLabel,
  isOpeningHardGateError,
  OpeningHardGateError,
  resolveOpeningCheckHardGate,
} from "./hard-gate.js";
export type { OpeningCheckOverride } from "./hard-gate.js";
export {
  BACKGROUND_CHAR_LIMIT_VALUE,
  countVisibleChars,
  evidenceSupported,
  findBackgroundDumpSpans,
  paragraphHasDialogue,
  splitNarrativeParagraphs,
  stripPunctuation,
  verifyQuotes,
} from "./evidence.js";
export {
  applyQuoteVerification,
  extractJsonValue,
  fillChecklistItems,
  parseOpeningCheckResponse,
  type ParsedOpeningCheckItem,
} from "./parse.js";
export { OPENING_CHECK_SYSTEM_PROMPT, buildOpeningCheckUserPrompt, openingCheckWritingTemplateHook } from "./prompt.js";
export {
  openingCheckJsonPath,
  openingCheckMarkdownPath,
  readOpeningCheckReport,
  renderOpeningCheckMarkdown,
  writeOpeningCheckReport,
} from "./report.js";
export {
  OPENING_CHECK_CHAPTER_LIMIT,
  applyBackgroundPrecheck,
  loadOpeningChapters,
  maybeRunOpeningCheckAfterChapter,
  resolveOpeningCheckEnabled,
  runOpeningCheck,
} from "./runner.js";
export type { RunOpeningCheckInput, RunOpeningCheckResult } from "./runner.js";
export type {
  BackgroundSpan,
  OpeningCheckBinding,
  OpeningCheckChapter,
  OpeningCheckItemResult,
  OpeningCheckLlm,
  OpeningCheckQuote,
  OpeningCheckReport,
  OpeningCheckVerdict,
  OpeningHardGateBlock,
  OpeningHardGateMode,
  OpeningHardGateResult,
} from "./types.js";
