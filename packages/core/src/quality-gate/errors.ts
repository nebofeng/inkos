export class QualityGatePauseError extends Error {
  readonly code = "QUALITY_GATE_PAUSE" as const;
  readonly chapterNumber: number;
  readonly reasons: readonly string[];

  constructor(chapterNumber: number, reasons: readonly string[]) {
    super(`Quality gate paused at chapter ${chapterNumber}: ${reasons.join("; ") || "failed"}`);
    this.name = "QualityGatePauseError";
    this.chapterNumber = chapterNumber;
    this.reasons = reasons;
  }
}

export function isQualityGatePauseError(error: unknown): error is QualityGatePauseError {
  if (error instanceof QualityGatePauseError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly name?: string; readonly code?: string };
  return (
    candidate.name === "QualityGatePauseError"
    || candidate.name === "DeAIPauseError"
    || candidate.code === "QUALITY_GATE_PAUSE"
    || candidate.code === "DEAI_PAUSE"
  );
}
