import { resolvePlatformPreset } from "../platform-presets/index.js";

export interface ShortAnswerArtifactSpec {
  readonly fileName: string;
  readonly relativePath: string;
  readonly platform: string;
  readonly metaFileName: string;
  readonly draftFileName: string;
}

const SHORT_ANSWER_ARTIFACTS_BY_PRESET: Readonly<Record<string, ShortAnswerArtifactSpec>> = {
  "zhihu-short": {
    fileName: "zhihu-answer.md",
    relativePath: "final/zhihu-answer.md",
    platform: "zhihu",
    metaFileName: "zhihu-answer-meta.json",
    draftFileName: "zhihu-answer-draft.md",
  },
  "fanqie-short": {
    fileName: "fanqie-short.md",
    relativePath: "final/fanqie-short.md",
    platform: "fanqie",
    metaFileName: "fanqie-short-meta.json",
    draftFileName: "fanqie-short-draft.md",
  },
};

export function listShortAnswerArtifacts(): readonly ShortAnswerArtifactSpec[] {
  return Object.values(SHORT_ANSWER_ARTIFACTS_BY_PRESET);
}

/** Answer-form artifact paths. zhihu-short keeps `final/zhihu-answer.md` for live compatibility. */
export function shortAnswerArtifactForPreset(platformPreset?: string | null): ShortAnswerArtifactSpec | undefined {
  const preset = resolvePlatformPreset(platformPreset);
  if (preset?.shortForm !== "answer") return undefined;
  return SHORT_ANSWER_ARTIFACTS_BY_PRESET[preset.id] ?? {
    fileName: `${preset.id}.md`,
    relativePath: `final/${preset.id}.md`,
    platform: preset.id,
    metaFileName: `${preset.id}-meta.json`,
    draftFileName: `${preset.id}-draft.md`,
  };
}

export function shortAnswerArtifactByFileName(fileName: string | undefined | null): ShortAnswerArtifactSpec | undefined {
  const key = (fileName ?? "").trim();
  if (!key) return undefined;
  return listShortAnswerArtifacts().find((item) => item.fileName === key || item.relativePath === key);
}
