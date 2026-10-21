import type { ChapterMeta, DeslopStatus } from "../models/chapter.js";
import {
  evaluateOpeningHardGate,
  OpeningHardGateError,
  resolveOpeningCheckEnabled,
  resolveOpeningCheckHardGate,
  type OpeningCheckOverride,
} from "../opening-check/hard-gate.js";
import { readOpeningCheckReport } from "../opening-check/report.js";
import type { OpeningHardGateResult } from "../opening-check/types.js";

export function computePublishEligible(input: {
  readonly deslopStatus?: DeslopStatus;
  readonly detectionPassed?: boolean;
  readonly openingHardGatePassed?: boolean;
}): boolean {
  const deslopOk = input.deslopStatus === "ok" || input.deslopStatus === "skipped";
  const openingOk = input.openingHardGatePassed !== false;
  return deslopOk && input.detectionPassed === true && openingOk;
}

export function isPublishEligible(meta: Pick<ChapterMeta, "publishEligible">): boolean {
  return meta.publishEligible === true;
}

export function filterPublishPool<T extends Pick<ChapterMeta, "publishEligible">>(
  chapters: ReadonlyArray<T>,
): T[] {
  return chapters.filter(isPublishEligible);
}

export function applyOpeningHardGateToChapters<T extends ChapterMeta>(
  chapters: ReadonlyArray<T>,
  openingHardGatePassed: boolean,
): T[] {
  if (openingHardGatePassed) return [...chapters];
  return chapters.map((chapter) => (
    chapter.publishEligible === false ? chapter : { ...chapter, publishEligible: false }
  ));
}

export async function resolveBookOpeningHardGate(input: {
  readonly bookDir: string;
  readonly projectOpeningCheck?: OpeningCheckOverride;
  readonly bookOpeningCheck?: OpeningCheckOverride;
}): Promise<OpeningHardGateResult> {
  const enabled = resolveOpeningCheckEnabled(input.projectOpeningCheck, input.bookOpeningCheck);
  const hardGate = resolveOpeningCheckHardGate(input.projectOpeningCheck, input.bookOpeningCheck);
  if (!enabled) {
    return evaluateOpeningHardGate({ items: [], skipped: true, skipReason: "开篇检查已关闭（openingCheck.enabled=false）" }, {
      enabled: false,
      hardGate,
    });
  }
  const report = await readOpeningCheckReport(input.bookDir);
  if (!report) {
    return {
      passed: !hardGate,
      mode: hardGate ? "hard" : "soft",
      blocks: [
        { id: "5a", title: "金手指", verdict: "unverified", suggestion: "尚未跑开篇检查。" },
        { id: "5b", title: "黄金500字钩", verdict: "unverified", suggestion: "尚未跑开篇检查。" },
        { id: 7, title: "前期小 boss", verdict: "unverified", suggestion: "尚未跑开篇检查。" },
      ],
      reason: hardGate
        ? "开篇硬闸未通过：缺开篇检查报告（fail-closed）"
        : "开篇硬挡未核验（软闸，不挡发）：缺开篇检查报告",
    };
  }
  return evaluateOpeningHardGate(report, { enabled: true, hardGate });
}

export async function assertOpeningHardGateForExport(input: {
  readonly bookDir: string;
  readonly projectOpeningCheck?: OpeningCheckOverride;
  readonly bookOpeningCheck?: OpeningCheckOverride;
}): Promise<OpeningHardGateResult> {
  const evaluation = await resolveBookOpeningHardGate(input);
  if (!evaluation.passed) throw new OpeningHardGateError(evaluation);
  return evaluation;
}
