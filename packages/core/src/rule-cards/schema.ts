import { z } from "zod";

export const RULE_CARD_STAGES = ["planner", "writer", "auditor", "reviser", "stuck"] as const;
export const RULE_CARD_SCOPES = ["opening", "early", "any", "short"] as const;
export const RULE_CARD_PRIORITIES = ["high", "mid", "low"] as const;

export const RuleCardStageSchema = z.enum(RULE_CARD_STAGES);
export const RuleCardScopeSchema = z.enum(RULE_CARD_SCOPES);
export const RuleCardPrioritySchema = z.enum(RULE_CARD_PRIORITIES);

export type RuleCardStage = z.infer<typeof RuleCardStageSchema>;
export type RuleCardScope = z.infer<typeof RuleCardScopeSchema>;
export type RuleCardPriority = z.infer<typeof RuleCardPrioritySchema>;

function oneOrMore<T extends z.ZodTypeAny>(item: T) {
  return z.union([item, z.array(item)]).transform((value) => (Array.isArray(value) ? value : [value]));
}

export const RuleCardSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  rule: z.string().trim().min(1),
  check: z.string().trim().min(1),
  good: z.string().optional(),
  bad: z.string().optional(),
  stage: oneOrMore(RuleCardStageSchema).pipe(z.array(RuleCardStageSchema).min(1)),
  scope: oneOrMore(RuleCardScopeSchema).pipe(z.array(RuleCardScopeSchema).min(1)),
  genre: oneOrMore(z.string().trim().min(1)).pipe(z.array(z.string().min(1)).min(1)),
  priority: RuleCardPrioritySchema,
  source: z.string().optional(),
});

export type RuleCard = z.infer<typeof RuleCardSchema>;

export function parseRuleCard(input: unknown): RuleCard {
  return RuleCardSchema.parse(input);
}

export function safeParseRuleCard(
  input: unknown,
): { ok: true; card: RuleCard } | { ok: false; error: string } {
  const parsed = RuleCardSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, card: parsed.data };
  }
  return {
    ok: false,
    error: parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("; "),
  };
}
