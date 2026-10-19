import { useEffect, useMemo, useState } from "react";
import { useApi } from "../hooks/use-api";
import { useNetworkBackoffRetry } from "../hooks/use-network-backoff";
import { isNetworkErrorMessage } from "../lib/network-error";
import { collectionListStatus } from "./sidebar-collection-status";
import type { SSEMessage } from "../hooks/use-sse";
import { applyBookCollectionEvent, shouldRefetchBookCollections, shouldRefetchDaemonStatus } from "../hooks/use-book-activity";
import type { TFunction } from "../hooks/use-i18n";
import { tr } from "../lib/app-language";
import { setProjectChatSessionId } from "../pages/chat-page-state";
import { useChatStore } from "../store/chat";
import { ConfirmDialog } from "./ConfirmDialog";
import { SidebarFooter } from "./SidebarFooter";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Settings,
  Cpu,
  LayoutGrid,
  Terminal,
  Plus,
  MessageSquare,
  Gamepad2,
  ScrollText,
  BookPlus,
  BookCopy,
  Boxes,
  Feather,
  Wand2,
  FileInput,
  TrendingUp,
  Stethoscope,
  Zap,
  FolderOpen,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  GitBranch,
  Clapperboard,
  Rows3,
  Film,
  Languages,
  X,
} from "lucide-react";
import { InkosLogo } from "./InkosLogo";
import { useIsMobile } from "../hooks/use-mobile";
import { shouldShowBookSessionEntry } from "./sidebar-session-visibility";
import { buildCreatePreview } from "./sidebar-create-preview";
import { shouldShowFoundationReviewDot } from "../pages/foundation-review-banner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

// 历史记录里的会话混装多种类型（chat / short / play / book-create），用图标区分。
function SessionKindIcon({ kind, className }: { readonly kind?: string; readonly className?: string }) {
  const Icon =
    kind === "play" ? Gamepad2
    : kind === "short" ? ScrollText
    : kind === "script" ? Clapperboard
    : kind === "storyboard" ? Rows3
    : kind === "interactive-film" ? Film
    : kind === "book-create" ? BookPlus
    : MessageSquare;
  return <Icon size={13} className={className} />;
}

interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly foundationReviewStatus?: string;
}

interface ShortPreview {
  readonly id: string;
  readonly title: string;
  readonly batch?: string;
}

interface Nav {
  toDashboard: () => void;
  toChat: () => void;
  toBook: (id: string) => void;
  toBookCreate: () => void;
  toServices: () => void;
  toProjectSettings: () => void;
  toDaemon: () => void;
  toLogs: () => void;
  toGenres: () => void;
  toStyle: () => void;
  toTranslation: () => void;
  toImport: (tab?: "chapters" | "canon" | "fanfic" | "spinoff" | "imitation") => void;
  toRadar: () => void;
  toDoctor: () => void;
  toFilmStudio: (id: string) => void;
  toShorts: () => void;
  toShort: (id: string) => void;
}

export function Sidebar({ nav, activePage, bookWorkspaceId, sse, t, mobileOpen = false, onMobileClose, collapsed = false }: {
  nav: Nav;
  activePage: string;
  /** 仅书籍工作区（右侧 BookChatRail）传入，用于收起该书左侧会话入口。 */
  bookWorkspaceId?: string;
  sse: { messages: ReadonlyArray<SSEMessage> };
  t: TFunction;
  /** Phones (< md): the sidebar is an off-canvas drawer controlled by the app header. */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  /** Mid-width (768–1279): icon rail so Chat keeps ≥~580px. */
  collapsed?: boolean;
}) {
  const isMobile = useIsMobile();
  const [moreOpen, setMoreOpen] = useState(false);
  const rail = collapsed && !isMobile && !mobileOpen;
  const drawerClosed = (isMobile || collapsed) && !mobileOpen && !rail;
  useEffect(() => {
    if (!isMobile || !mobileOpen || !onMobileClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onMobileClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, mobileOpen, onMobileClose]);
  const { data, error: booksError, refetch: refetchBooks, mutate: mutateBooks } = useApi<{ books: ReadonlyArray<BookSummary> }>("/books");
  const { data: shortsData, error: shortsError, refetch: refetchShorts } = useApi<{ shorts: ReadonlyArray<ShortPreview> }>("/shorts");
  const { data: filmsData, error: filmsError, refetch: refetchFilms } = useApi<{ films: ReadonlyArray<{ projectId: string; title: string }> }>("/interactive-films");
  const { data: daemon, refetch: refetchDaemon } = useApi<{ running: boolean }>("/daemon");
  const sessions = useChatStore((s) => s.sessions);
  const sessionIdsByBook = useChatStore((s) => s.sessionIdsByBook);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const loadSessionList = useChatStore((s) => s.loadSessionList);
  const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
  const activateSession = useChatStore((s) => s.activateSession);
  const createDraftSession = useChatStore((s) => s.createDraftSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const setInput = useChatStore((s) => s.setInput);
  const [renameTarget, setRenameTarget] = useState<{ sessionId: string; currentTitle: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; title: string } | null>(null);
  const [expandedBooks, setExpandedBooks] = useState<Set<string>>(new Set());
  const [projectChatExpanded, setProjectChatExpanded] = useState(true);
  const [myBooksExpanded, setMyBooksExpanded] = useState(true);
  const [longformExpanded, setLongformExpanded] = useState(true);
  const [shortsExpanded, setShortsExpanded] = useState(true);
  const [filmsExpanded, setFilmsExpanded] = useState(true);

  const books = data?.books ?? [];
  const shorts = shortsData?.shorts ?? [];
  const films = filmsData?.films ?? [];
  const createPreview = useMemo(() => buildCreatePreview({ books, shorts }), [books, shorts]);
  const longformStatus = collectionListStatus(booksError, createPreview.longform.total);
  const shortsStatus = collectionListStatus(shortsError, createPreview.shorts.total);
  const filmsStatus = collectionListStatus(filmsError, films.length);
  const { resetRetries: resetShortsRetries } = useNetworkBackoffRetry({
    isNetworkError: Boolean(shortsError && isNetworkErrorMessage(shortsError)),
    hasData: Boolean(shortsData),
    refetch: refetchShorts,
  });
  const { resetRetries: resetFilmsRetries } = useNetworkBackoffRetry({
    isNetworkError: Boolean(filmsError && isNetworkErrorMessage(filmsError)),
    hasData: Boolean(filmsData),
    refetch: refetchFilms,
  });
  const longformActive = activePage === "dashboard" || activePage === "book-create" || activePage.startsWith("book:");
  const shortsActive = activePage === "shorts";
  const projectChatKey = "__null__";
  const projectChatSessions = useMemo(
    () =>
      (sessionIdsByBook[projectChatKey] ?? [])
        .map((sessionId) => sessions[sessionId])
        .filter((session): session is NonNullable<(typeof sessions)[string]> => {
          if (!session) return false;
          return Boolean(session.title)
            || session.messages.length > 0
            || session.isDraft
            || session.sessionId === activeSessionId;
        }),
    [activeSessionId, sessionIdsByBook, sessions],
  );

  useEffect(() => {
    const recent = sse.messages.at(-1);
    if (!recent) return;
    if (shouldRefetchBookCollections(recent)) {
      let appliedIncrementally = false;
      mutateBooks((current) => {
        const updatedBooks = applyBookCollectionEvent(current?.books ?? [], recent);
        if (!updatedBooks) return current;
        appliedIncrementally = true;
        return { books: updatedBooks };
      });
      if (appliedIncrementally) {
        return;
      }
      refetchBooks();
    }
    if (shouldRefetchDaemonStatus(recent)) {
      refetchDaemon();
    }
  }, [mutateBooks, refetchBooks, refetchDaemon, sse.messages]);

  // bookDataVersion 变化（外部数据信号）时才重拉当前已展开书的 session 列表；
  // 展开/折叠本身不触发请求（展开由 toggleBook 驱动，已带"首次加载"判断）。
  useEffect(() => {
    for (const bookId of expandedBooks) {
      if (!shouldShowBookSessionEntry(bookWorkspaceId, bookId)) continue;
      void loadSessionList(bookId);
    }
    if (projectChatExpanded) {
      void loadSessionList(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookWorkspaceId, bookDataVersion, loadSessionList, projectChatExpanded]);

  useEffect(() => {
    void refetchFilms();
    void refetchShorts();
    // RD-045: only re-run on bookDataVersion; refetch fns are stable but don't depend on them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookDataVersion]);

  useEffect(() => {
    if (activePage === "chat") {
      setProjectChatExpanded(true);
      void loadSessionList(null);
    }
  }, [activePage, loadSessionList]);

  const toggleBook = (bookId: string) => {
    setExpandedBooks((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) {
        next.delete(bookId);
        return next;
      }
      next.add(bookId);
      // 首次展开才拉：已有 sessionIdsByBook 数据就直接用缓存。
      // 书籍页该书会话入口已收起，避免与右栏重复请求。
      if (shouldShowBookSessionEntry(bookWorkspaceId, bookId) && sessionIdsByBook[bookId] === undefined) {
        void loadSessionList(bookId);
      }
      return next;
    });
  };

  const openBook = (bookId: string) => {
    setInput("");
    setExpandedBooks((prev) => {
      const next = new Set(prev);
      next.add(bookId);
      return next;
    });
    nav.toBook(bookId);
  };

  const sessionsByBook = useMemo(
    () =>
      Object.fromEntries(
        books.map((book) => [
          book.id,
          (sessionIdsByBook[book.id] ?? [])
            .map((sessionId) => sessions[sessionId])
            .filter(Boolean),
        ]),
      ) as Record<string, Array<(typeof sessions)[string]>>,
    [books, sessionIdsByBook, sessions],
  );

  const openSession = (bookId: string, sessionId: string) => {
    setInput("");
    activateSession(sessionId);
    nav.toBook(bookId);
    void loadSessionDetail(sessionId);
  };

  const handleCreateSession = (bookId: string) => {
    // 前端创建草稿会话：对话区立即变空，但 session 文件不落盘；
    // 发第一条消息时 sendMessage 会调 POST /sessions 真正创建。
    setExpandedBooks((prev) => new Set(prev).add(bookId));
    setInput("");
    createDraftSession(bookId, "book");
    nav.toBook(bookId);
  };

  const openProjectChatSession = (sessionId: string) => {
    setInput("");
    activateSession(sessionId);
    setProjectChatSessionId(sessionId);
    nav.toChat();
    void loadSessionDetail(sessionId);
  };

  const handleCreateProjectChatSession = (preset?: string) => {
    setProjectChatExpanded(true);
    const sessionId = createDraftSession(null, "chat");
    setProjectChatSessionId(sessionId);
    setInput(preset ?? "");
    nav.toChat();
  };

  const launchPlanningChat = (kind: "fanfic" | "spinoff" | "imitation" | "continuation") => {
    const presets: Record<typeof kind, { zh: string; en: string }> = {
      fanfic: { zh: "我想做同人企划：原作、角色关系、这次想写的冲突是……", en: "I want to plan a fanfic: source work, character relationships, and the conflict I want to write…" },
      spinoff: { zh: "我想做番外/衍生企划：从哪本书岔出去、新主角是谁、这条线要解决什么……", en: "I want to plan a spin-off: which book it branches from, who the new lead is, and what this line resolves…" },
      imitation: { zh: "我想仿写一部作品的节奏和语气，但故事完全原创。参考作品和我想保留的味道是……", en: "I want to imitate another work’s pacing and tone, with an original story. The reference and the flavor to keep are…" },
      continuation: { zh: "我想续写：原作停在哪里、我打算怎么接、不能改动的事实是……", en: "I want a continuation: where the original stopped, how I will pick it up, and which facts must not change…" },
    };
    const copy = presets[kind];
    handleCreateProjectChatSession(t("nav.connected") === "已连接" ? copy.zh : copy.en);
  };

  const handleOpenBookCreate = () => {
    setInput("");
    nav.toBookCreate();
  };

  const launchProjectMode = (kind: "short" | "play" | "script" | "storyboard" | "interactive-film", playMode?: "guided" | "open") => {
    setProjectChatExpanded(true);
    // Play mode (分支互动 = guided / 自由互动 = open) is now decided here at the
    // launcher, not via an in-chat button.
    const sessionId = createDraftSession(null, kind, playMode);
    setProjectChatSessionId(sessionId);
    setInput("");
    nav.toChat();
  };

  const handleRenameConfirm = async () => {
    if (!renameTarget) return;
    const nextTitle = renameValue.trim();
    if (!nextTitle) return;
    await renameSession(renameTarget.sessionId, nextTitle);
    setRenameTarget(null);
    setRenameValue("");
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    await deleteSession(deleteTarget.sessionId);
    setDeleteTarget(null);
  };

  return (
    <>
    {(isMobile || collapsed) && mobileOpen && (
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm xl:hidden"
        onClick={onMobileClose}
        aria-hidden="true"
      />
    )}
    <aside
      data-drawer-state={drawerClosed ? "closed" : "open"}
      data-rail={rail ? "true" : undefined}
      inert={drawerClosed || undefined}
      aria-hidden={drawerClosed || undefined}
      className={`fixed inset-y-0 left-0 z-50 w-[min(85vw,300px)] transition-transform duration-200 ease-out ${
        rail
          ? "md:static md:z-auto md:w-16 md:translate-x-0 md:transition-none"
          : "xl:static xl:z-auto xl:w-[240px] xl:translate-x-0 xl:transition-none"
      } ${
        mobileOpen || rail ? "translate-x-0 shadow-2xl bg-background" : "-translate-x-full bg-background/80"
      } shrink-0 border-r border-border xl:bg-background/80 xl:shadow-none backdrop-blur-md flex flex-col h-full overflow-hidden select-none`}
    >
      {/* Logo Area */}
      <div className="flex items-center justify-between px-6 py-5 md:py-8">
        <button
          onClick={nav.toDashboard}
          className="group flex items-center gap-3 hover:opacity-80 transition-all duration-300"
        >
          <InkosLogo className="w-11 h-11 shrink-0 group-hover:scale-105 transition-transform" />
          {!rail && (
          <div className="flex flex-col">
            <span className="font-serif text-[27px] leading-none italic font-medium">InkOS</span>
            <span className="text-[13px] uppercase tracking-[0.22em] text-muted-foreground font-bold mt-1.5">Studio</span>
          </div>
          )}
        </button>
        {onMobileClose && (
          <button
            type="button"
            onClick={onMobileClose}
            aria-label={tr("关闭导航", "Close navigation")}
            className="xl:hidden -mr-3 inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
          >
            <X size={20} />
          </button>
        )}
      </div>

      {/* Main Navigation */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-6">
        {/* 新建互动影游 — 与「我的影游」列表分开，避免同名串项。 */}
        <div>
          {!rail && (
          <div className="px-3 mb-2.5">
            <span className="text-xs leading-5 uppercase tracking-[0.1em] text-muted-foreground font-bold">
              {t("nav.createSection")}
            </span>
          </div>
          )}
          <div className={rail ? "flex flex-col gap-1" : "grid grid-cols-1 gap-1.5"}>
            <CreateItem compact={rail} icon={<Film size={16} />} label={t("nav.createSection")} badge={t("nav.chatPlan")} onClick={() => launchProjectMode("interactive-film")} />
            {rail && (
              <>
                <SidebarItem compact label={t("nav.longform")} icon={<BookPlus size={16} />} active={longformActive} onClick={nav.toDashboard} />
                <SidebarItem compact label={t("nav.shorts")} icon={<ScrollText size={16} />} active={shortsActive} onClick={nav.toShorts} />
              </>
            )}
            <CreateItem compact={rail} icon={<LayoutGrid size={16} />} label={t("nav.moreTemplates")} onClick={() => setMoreOpen(true)} />
          </div>
        </div>

        {/* 我的创作：同级只保留长篇/短篇类别，书名只出现在展开后的预览里。 */}
        {!rail && <div data-testid="my-works-section">
          <SectionHeader label={t("nav.myBooks")} expanded={myBooksExpanded} onToggle={() => setMyBooksExpanded((v) => !v)} />
          <Collapse open={myBooksExpanded}>
          <div className="space-y-0.5 pt-1">
            <CreateCategoryBlock
              testId="create-category-longform"
              label={t("nav.longform")}
              icon={<BookPlus size={16} />}
              active={longformActive}
              expanded={longformExpanded}
              onToggle={() => setLongformExpanded((v) => !v)}
              onOpenAll={nav.toDashboard}
              viewAllLabel={t("nav.viewAll")}
            >
              {createPreview.longform.items.map((book) => {
                const bookSessions = sessionsByBook[book.id] ?? [];
                const isActiveBook = activePage === `book:${book.id}`;
                const showBookSessions = shouldShowBookSessionEntry(bookWorkspaceId, book.id);
                const isExpanded = showBookSessions && expandedBooks.has(book.id);
                return (
                  <div key={book.id} data-testid={`create-preview-book-${book.id}`}>
                    {/* 书名行：箭头展开会话；标题进入该书。 */}
                    <div className="group/book flex items-center">
                      {showBookSessions ? (
                      <button
                        type="button"
                        aria-label={isExpanded ? tr(`折叠 ${book.title}`, `Collapse ${book.title}`) : tr(`展开 ${book.title}`, `Expand ${book.title}`)}
                        onClick={() => toggleBook(book.id)}
                        className="flex h-11 w-11 md:h-8 md:w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary/30 hover:text-foreground transition-colors"
                      >
                        <ChevronRight
                          size={12}
                          className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
                        />
                      </button>
                      ) : (
                      <span className="flex h-11 w-11 md:h-8 md:w-7 shrink-0" aria-hidden="true" />
                      )}
                      <button
                        type="button"
                        onClick={() => openBook(book.id)}
                        className={`flex min-h-11 md:min-h-0 min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 rounded-md text-[15px] leading-6 transition-colors ${
                          isActiveBook ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary/30"
                        }`}
                      >
                        <FolderOpen size={14} className="shrink-0 text-muted-foreground/60" />
                        <span className="truncate flex-1 text-left">{book.title}</span>
                        {shouldShowFoundationReviewDot(book.foundationReviewStatus) && (
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
                            title={t("book.foundationReviewWriteWarn")}
                            aria-label={t("book.foundationReviewWriteWarn")}
                          />
                        )}
                      </button>
                    </div>

                    <Collapse open={isExpanded}>
                      <div className="mt-0.5">
                        {bookSessions.map((session) => {
                          const isActiveSession = isActiveBook && activeSessionId === session.sessionId;
                          const label = getSessionLabel(session);
                          return (
                            <div
                              key={session.sessionId}
                              className={`group/session flex items-center rounded-md ${isActiveSession ? "bg-secondary/50" : "hover:bg-secondary/30"}`}
                            >
                              <button
                                type="button"
                                onClick={() => openSession(book.id, session.sessionId)}
                                className="flex min-h-11 md:min-h-0 min-w-0 flex-1 items-center gap-2 pl-9 pr-2 py-1.5 text-left text-[14px] leading-5 transition-colors"
                              >
                                <span className={`truncate flex-1 ${isActiveSession ? "text-foreground" : "text-muted-foreground group-hover/session:text-foreground"}`}>
                                  {label}
                                </span>
                                {session.isStreaming ? (
                                  <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
                                ) : (
                                  <span className="shrink-0 text-[11px] text-muted-foreground/40">
                                    {formatRelativeTime(session.sessionId)}
                                  </span>
                                )}
                              </button>

                              <DropdownMenu>
                                <DropdownMenuTrigger className="flex h-11 w-11 md:h-6 md:w-6 shrink-0 items-center justify-center rounded opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/session:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground transition-opacity">
                                  <MoreHorizontal size={14} />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent side="right" align="start" className="w-36">
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setRenameTarget({ sessionId: session.sessionId, currentTitle: label });
                                      setRenameValue(session.title ?? "");
                                    }}
                                  >
                                    <Pencil size={14} />
                                    <span>{tr("改名", "Rename")}</span>
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onClick={() => setDeleteTarget({ sessionId: session.sessionId, title: label })}
                                  >
                                    <Trash2 size={14} />
                                    <span>{tr("删除", "Delete")}</span>
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => void handleCreateSession(book.id)}
                          className="w-full flex min-h-11 md:min-h-0 items-center gap-2 pl-9 pr-2 py-1.5 text-[13px] text-muted-foreground/50 hover:text-foreground transition-colors"
                        >
                          <Plus size={12} />
                          <span>{tr("新建会话", "New session")}</span>
                        </button>
                      </div>
                    </Collapse>
                  </div>
                );
              })}
              {longformStatus === "error" && (
                <button
                  type="button"
                  data-testid="sidebar-books-retry"
                  onClick={() => { void refetchBooks(); }}
                  className="px-3 py-3 text-left text-xs text-destructive hover:underline"
                >
                  {tr("加载失败，点此重试", "Failed to load. Tap to retry")}
                </button>
              )}
              {longformStatus === "empty" && (
                <div className="px-3 py-3 text-xs text-muted-foreground/50 italic">
                  {t("dash.noBooks")}
                </div>
              )}
            </CreateCategoryBlock>

            <CreateCategoryBlock
              testId="create-category-shorts"
              label={t("nav.shorts")}
              icon={<ScrollText size={16} />}
              active={shortsActive}
              expanded={shortsExpanded}
              onToggle={() => setShortsExpanded((v) => !v)}
              onOpenAll={nav.toShorts}
              viewAllLabel={t("nav.viewAll")}
            >
              {createPreview.shorts.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`create-preview-short-${item.id}`}
                  onClick={() => nav.toShort(item.id)}
                  className="w-full flex min-h-11 md:min-h-0 items-center gap-1.5 px-3 py-1.5 rounded-md text-left text-[15px] leading-6 text-muted-foreground hover:text-foreground hover:bg-secondary/30 transition-colors"
                >
                  <ScrollText size={14} className="shrink-0 text-muted-foreground/60" />
                  <span className="truncate flex-1">{item.title}</span>
                </button>
              ))}
              {shortsStatus === "error" && (
                <button
                  type="button"
                  data-testid="sidebar-shorts-retry"
                  onClick={() => { resetShortsRetries(); void refetchShorts(); }}
                  className="px-3 py-3 text-left text-xs text-destructive hover:underline"
                >
                  {tr("加载失败，点此重试", "Failed to load. Tap to retry")}
                </button>
              )}
              {shortsStatus === "empty" && (
                <div className="px-3 py-3 text-xs text-muted-foreground/50 italic">
                  {t("nav.noShorts")}
                </div>
              )}
            </CreateCategoryBlock>
          </div>
          </Collapse>
        </div>}

        {/* 我的影游 */}
        {!rail && <div data-testid="film-projects-section">
          <SectionHeader label={t("nav.myFilms")} expanded={filmsExpanded} onToggle={() => setFilmsExpanded((v) => !v)} />
          <Collapse open={filmsExpanded}>
            <div className="space-y-0.5 pt-1">
              {films.map((film) => {
                const isActiveFilm = activePage === `film:${film.projectId}`;
                return (
                <button
                  key={film.projectId}
                  type="button"
                  data-testid={`film-project-${film.projectId}`}
                  onClick={() => nav.toFilmStudio(film.projectId)}
                  className={`w-full flex min-h-11 md:min-h-0 items-center gap-2 px-3 py-1.5 rounded-lg text-left transition-colors ${
                    isActiveFilm ? "bg-secondary/50 text-foreground font-medium" : "hover:bg-secondary/30"
                  }`}
                >
                  <Film size={14} className={`shrink-0 ${isActiveFilm ? "text-primary" : "text-muted-foreground"}`} />
                  <span className="truncate text-[15px]">{film.title}</span>
                </button>
                );
              })}
              {filmsStatus === "error" && (
                <button
                  type="button"
                  data-testid="sidebar-films-retry"
                  onClick={() => { resetFilmsRetries(); void refetchFilms(); }}
                  className="px-3 py-3 text-left text-xs text-destructive hover:underline"
                >
                  {tr("加载失败，点此重试", "Failed to load. Tap to retry")}
                </button>
              )}
              {filmsStatus === "empty" && (
                <div className="px-3 py-6 text-xs text-muted-foreground/50 italic text-center">
                  {tr("还没有互动影游项目", "No interactive film projects yet")}
                </div>
              )}
            </div>
          </Collapse>
        </div>}

        {/* Sessions Section */}
        {!rail && <div>
          <SectionHeader
            label={t("nav.history")}
            expanded={projectChatExpanded}
            onToggle={() => {
              const next = !projectChatExpanded;
              setProjectChatExpanded(next);
              if (next) {
                nav.toChat();
                if (sessionIdsByBook[projectChatKey] === undefined) {
                  void loadSessionList(null);
                }
              }
            }}
          />
          <div className="space-y-1">
            <div>
              <Collapse open={projectChatExpanded}>
                <div className="pt-1">
                  {projectChatSessions.map((session) => {
                    const isActiveSession = activePage === "chat" && activeSessionId === session.sessionId;
                    const label = getSessionLabel(session);
                    return (
                      <div
                        key={session.sessionId}
                        className={`group/session flex items-center rounded-md ${isActiveSession ? "bg-secondary/50" : "hover:bg-secondary/30"}`}
                      >
                        <button
                          type="button"
                          onClick={() => openProjectChatSession(session.sessionId)}
                          className="flex min-h-11 md:min-h-0 min-w-0 flex-1 items-center gap-2 pl-2 pr-2 py-1.5 text-left text-[14px] leading-5 transition-colors"
                        >
                          <SessionKindIcon
                            kind={session.sessionKind}
                            className={`shrink-0 ${isActiveSession ? "text-foreground" : "text-muted-foreground/60 group-hover/session:text-foreground"}`}
                          />
                          <span className={`truncate flex-1 ${isActiveSession ? "text-foreground" : "text-muted-foreground group-hover/session:text-foreground"}`}>
                            {label}
                          </span>
                          {session.isStreaming ? (
                            <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
                          ) : (
                            <span className="shrink-0 text-[11px] text-muted-foreground/40">
                              {formatRelativeTime(session.sessionId)}
                            </span>
                          )}
                        </button>

                        <DropdownMenu>
                          <DropdownMenuTrigger className="flex h-11 w-11 md:h-6 md:w-6 shrink-0 items-center justify-center rounded opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/session:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground transition-opacity">
                            <MoreHorizontal size={14} />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent side="right" align="start" className="w-36">
                            <DropdownMenuItem
                              onClick={() => {
                                setRenameTarget({ sessionId: session.sessionId, currentTitle: label });
                                setRenameValue(session.title ?? "");
                              }}
                            >
                              <Pencil size={14} />
                              <span>{tr("改名", "Rename")}</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDeleteTarget({ sessionId: session.sessionId, title: label })}
                            >
                              <Trash2 size={14} />
                              <span>{tr("删除", "Delete")}</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => handleCreateProjectChatSession()}
                    className="w-full flex min-h-11 md:min-h-0 items-center gap-2 pl-2 pr-2 py-1.5 text-[13px] text-muted-foreground/50 hover:text-foreground transition-colors"
                  >
                    <Plus size={12} />
                    <span>{tr("新建会话", "New session")}</span>
                  </button>
                </div>
              </Collapse>
            </div>
          </div>
        </div>}

        {/* System Section */}
        <div>
          {!rail && <div className="px-3 mb-3">
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">
              {t("nav.system")}
            </span>
          </div>}
          <div className="space-y-1">
            <SidebarItem
              label={t("create.genre")}
              icon={<Boxes size={16} />}
              active={activePage === "genres"}
              onClick={nav.toGenres}
              compact={rail}
            />
            <SidebarItem
              label={t("nav.config")}
              icon={<Cpu size={16} />}
              active={activePage === "services"}
              onClick={nav.toServices}
              compact={rail}
            />
            <div className="h-3" aria-hidden="true" />
            <SidebarItem
              label={t("nav.projectSettings")}
              icon={<Settings size={16} />}
              active={activePage === "project-settings"}
              onClick={nav.toProjectSettings}
              compact={rail}
            />
            <SidebarItem
              label={t("nav.daemon")}
              icon={<Zap size={16} />}
              active={activePage === "daemon"}
              onClick={nav.toDaemon}
              badge={daemon?.running ? t("nav.running") : undefined}
              badgeColor={daemon?.running ? "bg-emerald-500/10 text-emerald-500" : "bg-muted text-muted-foreground"}
              compact={rail}
            />
            <SidebarItem
              label={t("nav.logs")}
              icon={<Terminal size={16} />}
              active={activePage === "logs"}
              onClick={nav.toLogs}
              compact={rail}
            />
          </div>
        </div>

        {/* Tools Section */}
        <div>
          {!rail && <div className="px-3 mb-3">
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-bold">
              {t("nav.tools")}
            </span>
          </div>}
          <div className="space-y-1">
            <SidebarItem
              label={t("nav.translation")}
              icon={<Languages size={16} />}
              active={activePage === "translation"}
              onClick={nav.toTranslation}
              compact={rail}
            />
            <SidebarItem
              label={t("nav.style")}
              icon={<Wand2 size={16} />}
              active={activePage === "style"}
              onClick={nav.toStyle}
              compact={rail}
            />
            <SidebarItem
              label={t("nav.import")}
              icon={<FileInput size={16} />}
              active={activePage === "import"}
              onClick={() => nav.toImport()}
              compact={rail}
            />
            <SidebarItem
              label={t("nav.radar")}
              icon={<TrendingUp size={16} />}
              active={activePage === "radar"}
              onClick={nav.toRadar}
              compact={rail}
            />
            <SidebarItem
              label={t("nav.doctor")}
              icon={<Stethoscope size={16} />}
              active={activePage === "doctor"}
              onClick={nav.toDoctor}
              compact={rail}
            />
          </div>
        </div>
      </div>

      {/* Footer / Status Area — agent status (when online) + logout */}
      <SidebarFooter agentOnline={Boolean(daemon?.running)} agentOnlineLabel={t("nav.agentOnline")} />

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null);
            setRenameValue("");
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-[360px] p-4 gap-3"
        >
          <DialogHeader className="space-y-0 gap-0">
            <DialogTitle className="font-sans text-sm font-medium">{tr("重命名会话", "Rename Session")}</DialogTitle>
          </DialogHeader>
          <input
            id="session-rename-input"
            autoFocus
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleRenameConfirm();
              }
            }}
            placeholder={tr("输入新标题", "Enter a new title")}
            className="w-full rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm outline-none focus:border-border"
          />
          <DialogFooter className="gap-1 sm:gap-1">
            <button
              type="button"
              onClick={() => {
                setRenameTarget(null);
                setRenameValue("");
              }}
              className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {tr("取消", "Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleRenameConfirm()}
              disabled={!renameValue.trim()}
              className="px-3 py-1 text-xs font-medium rounded-md bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-30"
            >
              {tr("保存", "Save")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent className="sm:max-w-md p-5 gap-4" data-testid="more-templates">
          <DialogHeader>
            <DialogTitle>{t("nav.moreTemplates")}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-1">
            <CreateItem icon={<BookPlus size={16} />} label={t("nav.createNovel")} onClick={() => { setMoreOpen(false); handleOpenBookCreate(); }} />
            <CreateItem icon={<ScrollText size={16} />} label={t("nav.createShort")} badge={t("nav.chatPlan")} onClick={() => { setMoreOpen(false); launchProjectMode("short"); }} />
            <CreateItem icon={<Clapperboard size={16} />} label={t("nav.createScript")} badge={t("nav.chatPlan")} onClick={() => { setMoreOpen(false); launchProjectMode("script"); }} />
            <CreateItem icon={<Rows3 size={16} />} label={t("nav.createStoryboard")} badge={t("nav.chatPlan")} onClick={() => { setMoreOpen(false); launchProjectMode("storyboard"); }} />
            <CreateItem icon={<GitBranch size={16} />} label={t("nav.createBranching")} badge={t("nav.chatPlan")} onClick={() => { setMoreOpen(false); launchProjectMode("play", "guided"); }} />
            <CreateItem icon={<Gamepad2 size={16} />} label={t("nav.createFree")} badge={t("nav.chatPlan")} onClick={() => { setMoreOpen(false); launchProjectMode("play", "open"); }} />
            <CreateItem icon={<Feather size={16} />} label={t("nav.createFanfic")} badge={t("nav.chatPlan")} onClick={() => { setMoreOpen(false); launchPlanningChat("fanfic"); }} />
            <CreateItem icon={<BookCopy size={16} />} label={t("nav.createSpinoff")} badge={t("nav.chatPlan")} onClick={() => { setMoreOpen(false); launchPlanningChat("spinoff"); }} />
            <CreateItem icon={<Wand2 size={16} />} label={t("nav.createImitation")} badge={t("nav.chatPlan")} onClick={() => { setMoreOpen(false); launchPlanningChat("imitation"); }} />
            <CreateItem icon={<FileInput size={16} />} label={t("nav.createContinuation")} badge={t("nav.chatPlan")} onClick={() => { setMoreOpen(false); launchPlanningChat("continuation"); }} />
            <CreateItem icon={<Languages size={16} />} label={t("nav.createTranslation")} onClick={() => { setMoreOpen(false); nav.toTranslation(); }} />
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={tr("删除会话", "Delete Session")}
        message={tr(
          `确认删除“${deleteTarget?.title ?? ""}”吗？该操作只删除这条会话，不影响书籍内容。`,
          `Delete "${deleteTarget?.title ?? ""}"? This only removes the session; the book content is not affected.`,
        )}
        confirmLabel={tr("删除", "Delete")}
        cancelLabel={tr("取消", "Cancel")}
        variant="danger"
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => setDeleteTarget(null)}
      />
    </aside>
    </>
  );
}

function getSessionLabel(session: { sessionId: string; title: string | null; messages: ReadonlyArray<{ role: string; content: string }> }): string {
  if (session.title) return session.title;
  // 后端会在第一条用户消息发送时立即把消息内容持久化为占位标题。
  // 这里处理的是"已有消息但标题还没同步回来"的短暂中间态（乐观显示）。
  const firstUserMsg = session.messages.find((m) => m.role === "user")?.content?.trim();
  if (firstUserMsg) {
    const oneLine = firstUserMsg.replace(/\s+/g, " ");
    return oneLine.length > 20 ? `${oneLine.slice(0, 20)}…` : oneLine;
  }
  return tr("新会话", "New session");
}

function formatRelativeTime(sessionId: string): string {
  const rawTs = Number(sessionId.split("-")[0]);
  if (!Number.isFinite(rawTs)) return "";
  const diff = Date.now() - rawTs;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return tr("刚刚", "just now");
  if (minutes < 60) return tr(`${minutes} 分钟`, `${minutes}m`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tr(`${hours} 小时`, `${hours}h`);
  const days = Math.floor(hours / 24);
  if (days < 30) return tr(`${days} 天`, `${days}d`);
  const months = Math.floor(days / 30);
  return tr(`${months} 个月`, `${months}mo`);
}

// Smooth collapse via grid-template-rows 0fr→1fr (content-height-agnostic, no JS measuring).
function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

function CreateCategoryBlock({
  testId,
  label,
  icon,
  active,
  expanded,
  onToggle,
  onOpenAll,
  viewAllLabel,
  children,
}: {
  testId: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenAll: () => void;
  viewAllLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <div className="group/cat flex items-center">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? tr(`折叠 ${label}`, `Collapse ${label}`) : tr(`展开 ${label}`, `Expand ${label}`)}
          onClick={onToggle}
          className="flex h-11 w-11 md:h-8 md:w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-secondary/30 hover:text-foreground transition-colors"
        >
          <ChevronRight
            size={14}
            className={`transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        <button
          type="button"
          onClick={onOpenAll}
          className={`flex min-h-11 md:min-h-0 min-w-0 flex-1 items-center gap-3 py-2 pr-2 rounded-lg text-sm transition-all duration-200 ${
            active
              ? "bg-secondary text-foreground font-medium shadow-sm border border-border"
              : "text-foreground font-medium hover:text-foreground hover:bg-secondary/50"
          }`}
        >
          <span className={`transition-colors ${active ? "text-primary" : "text-muted-foreground"}`}>
            {icon}
          </span>
          <span className="flex-1 text-left">{label}</span>
        </button>
      </div>
      <Collapse open={expanded}>
        <div className="space-y-0.5 pt-0.5">
          {children}
          <button
            type="button"
            data-testid={`${testId}-view-all`}
            onClick={onOpenAll}
            className="w-full flex min-h-11 md:min-h-0 items-center px-3 py-1.5 pl-9 text-[13px] text-muted-foreground/70 hover:text-foreground transition-colors"
          >
            {viewAllLabel}
          </button>
        </div>
      </Collapse>
    </div>
  );
}

function SectionHeader({ label, expanded, onToggle }: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group flex min-h-11 md:min-h-0 w-full items-center gap-1.5 px-3 py-2 text-left"
    >
      <span className="flex-1 text-[16px] leading-6 uppercase tracking-[0.1em] text-muted-foreground font-bold group-hover:text-foreground transition-colors">
        {label}
      </span>
      <ChevronRight
        size={15}
        className={`text-muted-foreground/50 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
      />
    </button>
  );
}

function RailTooltip({ compact, label, children }: {
  compact?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  if (!compact) return children;
  return (
    <TooltipProvider delay={0}>
      <Tooltip>
        <TooltipTrigger>{children}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function CreateItem({ icon, label, active, onClick, compact, badge }: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  compact?: boolean;
  badge?: string;
}) {
  return (
    <RailTooltip compact={compact} label={label}>
      <button
        type="button"
        onClick={onClick}
        className={`flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2.5 py-2.5 text-left text-xs sm:text-sm leading-5 transition-all ${
          compact ? "justify-center px-0" : ""
        } ${
          active
            ? "border border-border bg-secondary text-foreground font-medium shadow-sm"
            : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
        }`}
      >
        <span className={`shrink-0 ${active ? "text-primary" : ""}`}>{icon}</span>
        {!compact && <span className="truncate">{label}</span>}
        {!compact && badge && (
          <span className="ml-auto shrink-0 rounded-full border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {badge}
          </span>
        )}
      </button>
    </RailTooltip>
  );
}

function SidebarItem({ label, icon, active, onClick, badge, badgeColor, compact }: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: string;
  badgeColor?: string;
  compact?: boolean;
}) {
  return (
    <RailTooltip compact={compact} label={label}>
      <button
        type="button"
        onClick={onClick}
        className={`w-full group flex min-h-11 md:min-h-0 items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-200 ${
          compact ? "justify-center px-0" : ""
        } ${
          active
            ? "bg-secondary text-foreground font-medium shadow-sm border border-border"
            : "text-foreground font-medium hover:text-foreground hover:bg-secondary/50"
        }`}
      >
        <span className={`transition-colors ${active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"}`}>
          {icon}
        </span>
        {!compact && <span className="flex-1 text-left">{label}</span>}
        {!compact && badge && (
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-tight ${badgeColor}`}>
            {badge}
          </span>
        )}
      </button>
    </RailTooltip>
  );
}
