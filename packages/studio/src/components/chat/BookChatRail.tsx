import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Check, ChevronDown, PanelRightClose, PanelRightOpen, Plus } from "lucide-react";
import { tr } from "../../lib/app-language";
import { useChatStore } from "../../store/chat";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { clampChatWidth, readChatWidth, writeChatWidth } from "./book-chat-width";

const BOOK_CHAT_OPEN_KEY = "inkos:studio:book-chat-open";
const LG_QUERY = "(min-width: 1024px)";

function readBookChatOpen(): boolean {
  try {
    return window.localStorage.getItem(BOOK_CHAT_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeBookChatOpen(open: boolean): void {
  try {
    window.localStorage.setItem(BOOK_CHAT_OPEN_KEY, String(open));
  } catch {
    // Ignore storage failures and keep the in-memory choice for this session.
  }
}

function useIsLg(): boolean {
  const [lg, setLg] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia(LG_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(LG_QUERY);
    const update = () => setLg(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return lg;
}

function sessionLabel(session: {
  title: string | null;
  messages: ReadonlyArray<{ role: string; content: string }>;
}): string {
  if (session.title) return session.title;
  const firstUserMsg = session.messages.find((message) => message.role === "user")?.content?.trim();
  if (firstUserMsg) {
    const oneLine = firstUserMsg.replace(/\s+/g, " ");
    return oneLine.length > 20 ? `${oneLine.slice(0, 20)}…` : oneLine;
  }
  return tr("新会话", "New session");
}

export function BookChatRail({ bookId, children }: { readonly bookId: string; readonly children: ReactNode }) {
  const lg = useIsLg();
  const [desktopOpen, setDesktopOpen] = useState(readBookChatOpen);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [width, setWidth] = useState(() =>
    readChatWidth(
      typeof window === "undefined" ? null : window.localStorage,
      typeof window === "undefined" ? 1280 : window.innerWidth,
    ),
  );
  const widthRef = useRef(width);
  widthRef.current = width;
  const sessions = useChatStore((s) => s.sessions);
  const sessionIds = useChatStore((s) => s.sessionIdsByBook[bookId]);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const bookDataVersion = useChatStore((s) => s.bookDataVersion);
  const loadSessionList = useChatStore((s) => s.loadSessionList);
  const loadSessionDetail = useChatStore((s) => s.loadSessionDetail);
  const activateSession = useChatStore((s) => s.activateSession);
  const createDraftSession = useChatStore((s) => s.createDraftSession);
  const setInput = useChatStore((s) => s.setInput);

  useEffect(() => {
    void loadSessionList(bookId);
  }, [bookId, bookDataVersion, loadSessionList]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const bookSessions = useMemo(() => {
    const ordered: Array<(typeof sessions)[string]> = [];
    const seen = new Set<string>();
    for (const sessionId of sessionIds ?? []) {
      const session = sessions[sessionId];
      if (!session || seen.has(sessionId)) continue;
      seen.add(sessionId);
      ordered.push(session);
    }
    const active = activeSessionId ? sessions[activeSessionId] : undefined;
    if (active && active.bookId === bookId && !seen.has(active.sessionId)) {
      ordered.unshift(active);
    }
    return ordered;
  }, [activeSessionId, bookId, sessionIds, sessions]);

  const activeSession = bookSessions.find((session) => session.sessionId === activeSessionId) ?? bookSessions[0];

  const onResizeStart = useCallback((event: MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = widthRef.current;
    const onMove = (ev: globalThis.MouseEvent) => {
      const next = clampChatWidth(startW + (startX - ev.clientX));
      widthRef.current = next;
      setWidth(next);
    };
    const onUp = () => {
      writeChatWidth(typeof window === "undefined" ? null : window.localStorage, widthRef.current);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  const closeRail = () => {
    setMobileOpen(false);
    if (typeof window !== "undefined" && window.matchMedia?.(LG_QUERY).matches) {
      setDesktopOpen(false);
      writeBookChatOpen(false);
    }
  };

  const railOpen = lg ? desktopOpen : mobileOpen;

  return (
    <>
      {!desktopOpen && (
        <button
          type="button"
          data-testid="book-chat-open"
          onClick={() => {
            setDesktopOpen(true);
            writeBookChatOpen(true);
          }}
          className="fixed right-0 top-1/2 z-20 hidden -translate-y-1/2 items-center gap-1.5 rounded-l-lg border border-r-0 border-border/50 bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:border-primary/40 hover:text-primary lg:inline-flex"
        >
          <PanelRightOpen size={16} />
          {tr("AI 对话", "AI chat")}
        </button>
      )}
      {!mobileOpen && (
        <button
          type="button"
          data-testid="book-chat-open-mobile"
          onClick={() => setMobileOpen(true)}
          aria-label={tr("打开 AI 对话", "Open AI chat")}
          className="fixed right-4 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-20 inline-flex h-11 w-11 items-center justify-center rounded-full border border-border/50 bg-card p-0 text-sm font-medium text-foreground shadow-lg lg:hidden"
        >
          <PanelRightOpen size={16} />
        </button>
      )}

      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/20 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <aside
        data-testid="book-chat-rail"
        data-open={railOpen ? "true" : "false"}
        className={`relative min-h-0 flex-col overflow-hidden border-l border-border/30 bg-background ${
          mobileOpen ? "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:flex max-lg:w-[min(100vw,420px)] max-lg:shadow-xl max-lg:overscroll-contain" : "max-lg:hidden"
        } ${desktopOpen ? "lg:flex lg:h-full lg:shrink-0" : "lg:hidden"}`}
        style={lg && desktopOpen ? { width } : undefined}
      >
        <div
          onMouseDown={onResizeStart}
          className="absolute left-0 top-0 z-10 hidden h-full w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 lg:block"
        />
        <div className="flex shrink-0 items-center gap-1 border-b border-border/30 px-2 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid="book-session-switcher"
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/50"
            >
              <span className="truncate font-medium">
                {activeSession ? sessionLabel(activeSession) : tr("新会话", "New session")}
              </span>
              <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {bookSessions.length === 0 ? (
                <DropdownMenuItem disabled>{tr("还没有会话", "No sessions yet")}</DropdownMenuItem>
              ) : (
                bookSessions.map((session) => (
                  <DropdownMenuItem
                    key={session.sessionId}
                    onClick={() => {
                      setInput("");
                      activateSession(session.sessionId);
                      void loadSessionDetail(session.sessionId);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
                    {session.sessionId === activeSessionId ? <Check size={14} className="shrink-0" /> : null}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            data-testid="book-session-new"
            onClick={() => {
              setInput("");
              createDraftSession(bookId, "book");
            }}
            aria-label={tr("新建会话", "New session")}
            title={tr("新建会话", "New session")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            data-testid="book-chat-close"
            onClick={closeRail}
            aria-label={tr("收起 AI 对话", "Hide AI chat")}
            title={tr("收起 AI 对话", "Hide AI chat")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
          >
            <PanelRightClose size={16} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </aside>
    </>
  );
}
