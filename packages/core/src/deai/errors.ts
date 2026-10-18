import {
  QualityGatePauseError,
  isQualityGatePauseError,
} from "../quality-gate/errors.js";

/**
 * Thrown when deAI settle hits `onFail=pause`.
 * Subclass of QualityGatePauseError so existing catch sites keep working.
 */
export class DeAIPauseError extends QualityGatePauseError {
  constructor(chapterNumber: number, reasons: readonly string[]) {
    super(chapterNumber, reasons);
    this.name = "DeAIPauseError";
  }
}

export function isDeAIPauseError(error: unknown): error is DeAIPauseError | QualityGatePauseError {
  if (error instanceof DeAIPauseError) return true;
  return isQualityGatePauseError(error);
}
