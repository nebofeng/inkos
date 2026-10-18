export type DeAIOnFail = "warn" | "retry" | "pause";

export interface DeAISettingsDraft {
  enabled: boolean;
  aiFlavorThreshold: number;
  onFail: DeAIOnFail;
  maxRetries: number;
  skill: string;
}

export interface DeAISkillOption {
  readonly id: string;
  readonly source: string;
  readonly valid: boolean;
  readonly errors: ReadonlyArray<{ readonly code?: string; readonly message?: string }>;
  readonly description?: string;
  readonly shadowed?: boolean;
}

export const DEFAULT_DEAI_DRAFT: DeAISettingsDraft = {
  enabled: true,
  aiFlavorThreshold: 60,
  onFail: "warn",
  maxRetries: 1,
  skill: "inkos-story-deslop",
};

export function deAIDraftFromConfig(input: {
  readonly deAI?: Partial<DeAISettingsDraft> | null;
  readonly effective?: Partial<DeAISettingsDraft> | null;
}): DeAISettingsDraft {
  const stored = input.deAI ?? {};
  const effective = input.effective ?? {};
  const onFail = stored.onFail ?? effective.onFail ?? DEFAULT_DEAI_DRAFT.onFail;
  return {
    enabled: stored.enabled ?? effective.enabled ?? DEFAULT_DEAI_DRAFT.enabled,
    aiFlavorThreshold: stored.aiFlavorThreshold ?? effective.aiFlavorThreshold ?? DEFAULT_DEAI_DRAFT.aiFlavorThreshold,
    onFail: onFail === "retry" || onFail === "pause" ? onFail : "warn",
    maxRetries: stored.maxRetries ?? effective.maxRetries ?? DEFAULT_DEAI_DRAFT.maxRetries,
    skill: stored.skill ?? effective.skill ?? DEFAULT_DEAI_DRAFT.skill,
  };
}

export function buildDeAIConfig(draft: DeAISettingsDraft): DeAISettingsDraft {
  return {
    enabled: draft.enabled,
    aiFlavorThreshold: clampNumber(draft.aiFlavorThreshold, 0, 100, DEFAULT_DEAI_DRAFT.aiFlavorThreshold),
    onFail: draft.onFail,
    maxRetries: Math.round(clampNumber(draft.maxRetries, 0, 10, DEFAULT_DEAI_DRAFT.maxRetries)),
    skill: draft.skill.trim() || DEFAULT_DEAI_DRAFT.skill,
  };
}

export function skillOptionDisabled(skill: DeAISkillOption): boolean {
  return skill.valid === false;
}

export function formatSkillErrors(skill: DeAISkillOption): string {
  return skill.errors.map((error) => error.message ?? error.code ?? "invalid").filter(Boolean).join("; ");
}

/** Builtin default skill has no `kind: deai`; copies need it or save is rejected. */
export function prepareSkillEditorContent(content: string, source?: string): string {
  if (source !== "builtin") return content;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return content;
  if (/(^|\n)kind\s*:/i.test(match[1])) return content;
  return content.replace(/^---\r?\n/, "---\nkind: deai\n");
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
