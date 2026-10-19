export interface ChatPageModelInfo {
  readonly id: string;
  readonly name?: string;
}

export interface ChatPageModelGroup {
  readonly service: string;
  readonly label: string;
  readonly models: ReadonlyArray<ChatPageModelInfo>;
}

export interface ChatPageModelPreference {
  readonly model?: string | null;
  readonly service?: string | null;
}

export interface ChatPageSessionSummary {
  readonly sessionId: string;
  readonly sessionKind?: string;
  readonly messageCount: number;
}

const BOOK_CREATE_SESSION_KEY = "inkos.book-create.session-id";
const PROJECT_CHAT_SESSION_KEY = "inkos.project-chat.session-id";
export const BOOK_CREATE_DRAFT_KEY = "inkos:book-create-draft";

export interface BookCreateChatDraft {
  readonly title?: string;
  readonly genre?: string;
  readonly platform?: string;
  readonly targetChapters?: string;
  readonly chapterWordCount?: string;
  readonly blurb?: string;
  readonly world?: string;
  readonly protagonist?: string;
  readonly conflict?: string;
  readonly language?: "zh" | "en";
}

export function saveBookCreateDraft(draft: BookCreateChatDraft): void {
  try {
    globalThis.sessionStorage?.setItem(BOOK_CREATE_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Quota / private mode — skip handoff rather than break navigation.
  }
}

export function peekBookCreateDraft(): BookCreateChatDraft | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(BOOK_CREATE_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BookCreateChatDraft;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function consumeBookCreateDraft(): BookCreateChatDraft | null {
  const draft = peekBookCreateDraft();
  try {
    globalThis.sessionStorage?.removeItem(BOOK_CREATE_DRAFT_KEY);
  } catch {
    // ignore
  }
  return draft;
}

export function formatBookCreateDraftPrompt(draft: BookCreateChatDraft, language: "zh" | "en" = "zh"): string {
  const rows: Array<[string, string]> = language === "en"
    ? [
        ["Title", draft.title ?? ""],
        ["Genre", draft.genre ?? ""],
        ["Platform", draft.platform ?? ""],
        ["Target chapters", draft.targetChapters ?? ""],
        ["Words per chapter", draft.chapterWordCount ?? ""],
        ["Blurb", draft.blurb ?? ""],
        ["World", draft.world ?? ""],
        ["Protagonist", draft.protagonist ?? ""],
        ["Conflict", draft.conflict ?? ""],
      ]
    : [
        ["书名", draft.title ?? ""],
        ["题材", draft.genre ?? ""],
        ["目标平台", draft.platform ?? ""],
        ["目标章数", draft.targetChapters ?? ""],
        ["每章字数", draft.chapterWordCount ?? ""],
        ["简介", draft.blurb ?? ""],
        ["世界观", draft.world ?? ""],
        ["主角", draft.protagonist ?? ""],
        ["核心冲突", draft.conflict ?? ""],
      ];
  const filled = rows.filter(([, value]) => value.trim());
  if (filled.length === 0) return "";
  const body = filled.map(([label, value]) => `${label}：${value.trim()}`).join("\n");
  return language === "en"
    ? `Help me polish this book plan. Here is what I already filled in:\n\n${body}\n\nPlease refine the premise, keep what works, and ask for anything still missing.`
    : `请帮我润色这份建书企划。以下是我已经填好的内容：\n\n${body}\n\n请在保留可用设定的前提下润色完善，并指出还缺什么。`;
}

export function getBookCreateSessionId(): string | null {
  return globalThis.localStorage?.getItem(BOOK_CREATE_SESSION_KEY) ?? null;
}

export function setBookCreateSessionId(sessionId: string): void {
  globalThis.localStorage?.setItem(BOOK_CREATE_SESSION_KEY, sessionId);
}

export function clearBookCreateSessionId(): void {
  globalThis.localStorage?.removeItem(BOOK_CREATE_SESSION_KEY);
}

export function getProjectChatSessionId(): string | null {
  return globalThis.localStorage?.getItem(PROJECT_CHAT_SESSION_KEY) ?? null;
}

export function setProjectChatSessionId(sessionId: string): void {
  globalThis.localStorage?.setItem(PROJECT_CHAT_SESSION_KEY, sessionId);
}

export function filterModelGroups(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  search: string,
): ReadonlyArray<ChatPageModelGroup> {
  const query = search.trim().toLowerCase();
  if (!query) return groupedModels;

  return groupedModels
    .map((group) => ({
      ...group,
      models: group.models.filter((model) =>
        (model.name ?? model.id).toLowerCase().includes(query)
        || group.label.toLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.models.length > 0);
}

export function pickModelSelection(
  groupedModels: ReadonlyArray<ChatPageModelGroup>,
  selectedModel: string | null,
  selectedService: string | null,
  preference?: ChatPageModelPreference | null,
): { model: string; service: string } | null {
  const selectedStillAvailable = selectedModel && selectedService
    ? groupedModels.some((group) =>
        group.service === selectedService
        && group.models.some((model) => model.id === selectedModel),
      )
    : false;
  if (selectedStillAvailable) return null;

  const preferredService = preference?.service?.trim();
  const preferredModel = preference?.model?.trim();
  if (preferredService) {
    const preferredGroup = groupedModels.find((group) => group.service === preferredService);
    const exactModel = preferredModel
      ? preferredGroup?.models.find((model) => model.id === preferredModel)
      : undefined;
    if (preferredGroup && exactModel) {
      return { model: exactModel.id, service: preferredGroup.service };
    }
    const firstPreferredModel = preferredGroup?.models[0];
    if (preferredGroup && firstPreferredModel) {
      return { model: firstPreferredModel.id, service: preferredGroup.service };
    }
  }

  if (preferredModel) {
    for (const group of groupedModels) {
      const exactModel = group.models.find((model) => model.id === preferredModel);
      if (exactModel) return { model: exactModel.id, service: group.service };
    }
  }

  const firstGroup = groupedModels.find((group) => group.models.length > 0);
  const firstModel = firstGroup?.models[0];
  if (!firstGroup || !firstModel) return null;
  return { model: firstModel.id, service: firstGroup.service };
}

export function pickProjectChatSessionId(
  sessions: ReadonlyArray<ChatPageSessionSummary>,
): string | null {
  const projectSurfaceSessions = sessions.filter((session) =>
    !session.sessionKind
    || session.sessionKind === "chat"
    || session.sessionKind === "short"
    || session.sessionKind === "play"
    || session.sessionKind === "script"
    || session.sessionKind === "storyboard"
    || session.sessionKind === "interactive-film"
  );
  return projectSurfaceSessions.find((session) => session.messageCount > 0)?.sessionId
    ?? projectSurfaceSessions[0]?.sessionId
    ?? null;
}

export function shouldShowPlayChoicePanel(input: {
  readonly playMode?: string | null;
  readonly choiceSetKey?: string | null;
  readonly consumedChoiceKey?: string | null;
  readonly choiceCount: number;
}): boolean {
  if (input.playMode !== "guided") return false;
  if (!input.choiceSetKey) return false;
  if (input.choiceCount <= 0) return false;
  return input.choiceSetKey !== input.consumedChoiceKey;
}

export function isChatScrollNearBottom(input: {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly thresholdPx?: number;
}): boolean {
  const threshold = input.thresholdPx ?? 96;
  const distanceFromBottom = input.scrollHeight - input.scrollTop - input.clientHeight;
  return distanceFromBottom <= threshold;
}

export function getChatScrollBehavior(isStreaming: boolean): "auto" | "smooth" {
  return isStreaming ? "auto" : "smooth";
}

export const BOOK_CHAPTER_PROMPT_CHIPS = [
  "压缩开头到 200 字内",
  "这段对话再冲一点",
  "检查人名称谓前后一致",
  "去掉 AI 味",
] as const;

export function shouldShowBookChapterEmptyState(input: {
  readonly mode?: string;
  readonly artifactChapter: number | null;
  readonly messageCount: number;
  readonly loading?: boolean;
}): boolean {
  return input.mode === "book"
    && input.artifactChapter !== null
    && input.messageCount === 0
    && !input.loading;
}

export function countChapterWords(content: string | null | undefined): number {
  if (!content) return 0;
  return Array.from(content.replace(/\s+/g, "")).length;
}

export function formatBookChapterEmptyHeading(chapterNumber: number, title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `第 ${chapterNumber} 章 · ${trimmed}` : `第 ${chapterNumber} 章`;
}
