import { z } from "zod";
import { LengthTelemetrySchema } from "./length-governance.js";
import { WritingTemplateFieldsSchema } from "./writing-template.js";

export const ChapterStatusSchema = z.enum([
  "card-generated",
  "drafting",
  "drafted",
  "auditing",
  "audit-passed",
  "audit-failed",
  "state-degraded",
  "revising",
  "ready-for-review",
  "approved",
  "rejected",
  "published",
  "imported",
]);
export type ChapterStatus = z.infer<typeof ChapterStatusSchema>;

export const DeslopStatusSchema = z.enum(["pending", "ok", "failed", "skipped"]);
export type DeslopStatus = z.infer<typeof DeslopStatusSchema>;

export const ChapterMetaSchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  status: ChapterStatusSchema,
  wordCount: z.number().int().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  auditIssues: z.array(z.string()).default([]),
  lengthWarnings: z.array(z.string()).default([]),
  reviewNote: z.string().optional(),
  detectionScore: z.number().min(0).max(1).optional(),
  detectionProvider: z.string().optional(),
  detectedAt: z.string().datetime().optional(),
  deslopStatus: DeslopStatusSchema.optional(),
  deslopAt: z.string().datetime().optional(),
  detectionPassed: z.boolean().optional(),
  publishEligible: z.boolean().optional(),
  lengthTelemetry: LengthTelemetrySchema.optional(),
  tokenUsage: z.object({
    promptTokens: z.number().int().default(0),
    completionTokens: z.number().int().default(0),
    totalTokens: z.number().int().default(0),
  }).optional(),
  /** Optional chapter-level writing template; field-merged over book.writing.template. */
  writingTemplate: WritingTemplateFieldsSchema.optional(),
});

export type ChapterMeta = z.infer<typeof ChapterMetaSchema>;
