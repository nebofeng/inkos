import type { ChapterMeta, DeslopStatus } from "../models/chapter.js";

export function computePublishEligible(input: {
  readonly deslopStatus?: DeslopStatus;
  readonly detectionPassed?: boolean;
}): boolean {
  const deslopOk = input.deslopStatus === "ok" || input.deslopStatus === "skipped";
  return deslopOk && input.detectionPassed === true;
}

export function isPublishEligible(meta: Pick<ChapterMeta, "publishEligible">): boolean {
  return meta.publishEligible === true;
}

export function filterPublishPool<T extends Pick<ChapterMeta, "publishEligible">>(
  chapters: ReadonlyArray<T>,
): T[] {
  return chapters.filter(isPublishEligible);
}
