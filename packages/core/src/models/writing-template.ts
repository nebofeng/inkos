import { z } from "zod";

/**
 * Layered writing template (RD-050).
 *
 * Persistence:
 * - project: `writing.template` on inkos.json
 * - book:    `writing.template` on book.json
 * - chapter: `writingTemplate` on chapter meta (optional per-chapter override)
 *
 * Resolution is field-level: chapter → book → project → DEFAULT_WRITING_TEMPLATE.
 * Pure function; never mutates inputs.
 */

export const WritingTemplateFieldsSchema = z.object({
  proseStyle: z.string().min(1).optional(),
  satisfactionTypes: z.array(z.string().min(1)).optional(),
  openingStrategy: z.string().min(1).optional(),
  requireGoldenFinger: z.boolean().optional(),
  goldenFingerSoftGate: z.boolean().optional(),
  skillCardIds: z.array(z.string().min(1)).optional(),
  structureTemplateId: z.string().min(1).optional(),
  notes: z.string().optional(),
});

export type WritingTemplateFields = z.infer<typeof WritingTemplateFieldsSchema>;

export const WRITING_TEMPLATE_FIELD_KEYS = [
  "proseStyle",
  "satisfactionTypes",
  "openingStrategy",
  "requireGoldenFinger",
  "goldenFingerSoftGate",
  "skillCardIds",
  "structureTemplateId",
  "notes",
] as const satisfies ReadonlyArray<keyof WritingTemplateFields>;

export type WritingTemplateFieldKey = (typeof WRITING_TEMPLATE_FIELD_KEYS)[number];

export type WritingTemplateSource = "chapter" | "book" | "project" | "default";

export type WritingTemplateSources = Record<WritingTemplateFieldKey, WritingTemplateSource>;

export type EffectiveWritingTemplate = {
  effective: Required<Pick<
    WritingTemplateFields,
    "requireGoldenFinger" | "goldenFingerSoftGate"
  >> & WritingTemplateFields;
  sources: WritingTemplateSources;
};

export const DEFAULT_WRITING_TEMPLATE: EffectiveWritingTemplate["effective"] = {
  requireGoldenFinger: true,
  goldenFingerSoftGate: false,
};

function isSet<K extends WritingTemplateFieldKey>(
  layer: WritingTemplateFields | undefined,
  key: K,
): layer is WritingTemplateFields & Required<Pick<WritingTemplateFields, K>> {
  if (!layer) return false;
  const value = layer[key];
  return value !== undefined;
}

function copyField<K extends WritingTemplateFieldKey>(
  target: WritingTemplateFields,
  source: WritingTemplateFields,
  key: K,
): void {
  target[key] = source[key];
}

/**
 * Resolve the effective writing template.
 * Chapter overrides book overrides project overrides defaults, per field.
 */
export function resolveEffectiveWritingTemplate(input: {
  chapter?: WritingTemplateFields;
  book?: WritingTemplateFields;
  project?: WritingTemplateFields;
}): EffectiveWritingTemplate {
  const sources = {} as WritingTemplateSources;
  const merged: WritingTemplateFields = {
    requireGoldenFinger: DEFAULT_WRITING_TEMPLATE.requireGoldenFinger,
    goldenFingerSoftGate: DEFAULT_WRITING_TEMPLATE.goldenFingerSoftGate,
  };

  for (const key of WRITING_TEMPLATE_FIELD_KEYS) {
    if (isSet(input.chapter, key)) {
      copyField(merged, input.chapter, key);
      sources[key] = "chapter";
      continue;
    }
    if (isSet(input.book, key)) {
      copyField(merged, input.book, key);
      sources[key] = "book";
      continue;
    }
    if (isSet(input.project, key)) {
      copyField(merged, input.project, key);
      sources[key] = "project";
      continue;
    }
    sources[key] = "default";
  }

  const effective: EffectiveWritingTemplate["effective"] = {
    ...merged,
    requireGoldenFinger: merged.requireGoldenFinger ?? DEFAULT_WRITING_TEMPLATE.requireGoldenFinger,
    goldenFingerSoftGate: merged.goldenFingerSoftGate ?? DEFAULT_WRITING_TEMPLATE.goldenFingerSoftGate,
  };

  return { effective, sources };
}

/**
 * RD-049 hook: hard-block golden-finger opening check iff the effective
 * template requires a golden finger and is not in soft-gate mode.
 *
 * RD-049 should call this instead of a global boolean once wired.
 * Does not implement the gate itself.
 */
export function shouldHardBlockGoldenFinger(
  effective: Pick<WritingTemplateFields, "requireGoldenFinger" | "goldenFingerSoftGate">,
): boolean {
  return effective.requireGoldenFinger === true && effective.goldenFingerSoftGate !== true;
}

/** One-line summary for write-chapter prompt / opening-check context. */
export function formatWritingTemplateContext(
  resolved: EffectiveWritingTemplate,
): string {
  const { effective } = resolved;
  const parts: string[] = ["[writing-template]"];

  if (effective.proseStyle) {
    parts.push(`proseStyle=${effective.proseStyle}`);
  }
  if (effective.openingStrategy) {
    parts.push(`openingStrategy=${effective.openingStrategy}`);
  }
  if (effective.satisfactionTypes && effective.satisfactionTypes.length > 0) {
    parts.push(`satisfactionTypes=${effective.satisfactionTypes.join(",")}`);
  }

  const gf = shouldHardBlockGoldenFinger(effective)
    ? "goldenFinger=required-hard"
    : effective.requireGoldenFinger
      ? "goldenFinger=required-soft"
      : "goldenFinger=optional";
  parts.push(gf);

  if (effective.skillCardIds && effective.skillCardIds.length > 0) {
    parts.push(`skillCards=${effective.skillCardIds.join(",")}`);
  }
  if (effective.structureTemplateId) {
    parts.push(`structure=${effective.structureTemplateId}`);
  }

  return parts.join(" ");
}

export function mergeWritingTemplatePatch(
  current: WritingTemplateFields | undefined,
  patch: WritingTemplateFields,
): WritingTemplateFields {
  return WritingTemplateFieldsSchema.parse({
    ...(current ?? {}),
    ...patch,
  });
}

export function unsetWritingTemplateFields(
  current: WritingTemplateFields | undefined,
  keys: readonly WritingTemplateFieldKey[],
): WritingTemplateFields | undefined {
  if (!current) return undefined;
  const next: WritingTemplateFields = { ...current };
  for (const key of keys) {
    delete next[key];
  }
  const remaining = WRITING_TEMPLATE_FIELD_KEYS.some((k) => next[k] !== undefined);
  return remaining ? next : undefined;
}
