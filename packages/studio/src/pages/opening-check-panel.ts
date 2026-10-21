export interface OpeningCheckItemView {
  readonly id: number | string;
  readonly title: string;
  readonly verdict: "pass" | "fail" | "unverified";
  readonly suggestion?: string;
}

export interface OpeningHardGateBlockView {
  readonly id: number | string;
  readonly title: string;
  readonly verdict: "pass" | "fail" | "unverified";
  readonly suggestion?: string;
}

export interface OpeningHardGateView {
  readonly passed: boolean;
  readonly mode: "hard" | "soft" | "disabled";
  readonly blocks: readonly OpeningHardGateBlockView[];
  readonly reason?: string;
}

export interface OpeningCheckReportView {
  readonly items: readonly OpeningCheckItemView[];
  readonly skipped?: boolean;
  readonly skipReason?: string;
  readonly hardGate?: OpeningHardGateView;
}

export function openingCheckDisplayItems(
  report: OpeningCheckReportView | null | undefined,
): OpeningCheckItemView[] {
  if (!report?.items) return [];
  return report.items.filter((item) => typeof item.id === "number" || /^\d+$/.test(String(item.id)));
}

export function openingHardGateBlocked(hardGate: OpeningHardGateView | null | undefined): boolean {
  return Boolean(hardGate && hardGate.mode === "hard" && !hardGate.passed);
}

export function verdictZh(verdict: string): string {
  if (verdict === "pass") return "通过";
  if (verdict === "fail") return "不通过";
  return "未核验";
}
