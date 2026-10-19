import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  FileDiff,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RotateCcw,
  Sparkles,
  Wand2,
} from "lucide-react";
import { postApi } from "../../hooks/use-api";
import { tr } from "../../lib/app-language";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { lineDiffRows, type DeAIDiffRow } from "../../pages/deai-batch-model";
import {
  buildCondensePrompt,
  buildDeAIPrompt,
  buildExpandPrompt,
  buildRewritePrompt,
  shortPlatformPresetWords,
} from "../../pages/shorts-page-model";

const SHORT_CHAT_OPEN_KEY = "inkos:studio:short-chat-open";
const LG_QUERY = "(min-width: 1024px)";
const CHAT_MIN = 320;
const CHAT_MAX = 560;
const CHAT_DEFAULT = 420;

function readShortChatOpen(): boolean {
  try {
    return window.localStorage.getItem(SHORT_CHAT_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeShortChatOpen(open: boolean): void {
  try {
    window.localStorage.setItem(SHORT_CHAT_OPEN_KEY, String(open));
  } catch {
    // Ignore storage failures
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

export interface ShortsChatRailProps {
  readonly shortId: string;
  readonly title: string;
  readonly markdown: string;
  readonly platform?: string;
  readonly charBounds: { min: number; max: number };
  readonly readOnly: boolean;
  readonly onApplyMarkdown: (newMarkdown: string) => Promise<void>;
}

interface ChatMessageItem {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly candidateMarkdown?: string;
}

interface ChatSessionItem {
  readonly id: string;
  title: string;
  messages: ChatMessageItem[];
  pendingDiff?: { candidateMarkdown: string; reply: string } | null;
}

function countChars(text: string): number {
  return [...text].filter((ch) => !/\s/.test(ch)).length;
}

export function ShortsChatRail({
  shortId,
  title,
  markdown,
  platform,
  charBounds: _charBounds,
  readOnly,
  onApplyMarkdown,
}: ShortsChatRailProps) {
  const lg = useIsLg();
  const [desktopOpen, setDesktopOpen] = useState(readShortChatOpen);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [width, setWidth] = useState(CHAT_DEFAULT);

  const initialPreset = useMemo(() => shortPlatformPresetWords(platform), [platform]);
  const [targetWords, setTargetWords] = useState(initialPreset);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<ChatSessionItem[]>(() => [
    { id: `${Date.now()}-init`, title: "当前会话", messages: [] },
  ]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => sessions[0]!.id);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0]!;
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession.messages.length, activeSession.pendingDiff]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const onResizeStart = useCallback((event: MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = width;
    const onMove = (ev: globalThis.MouseEvent) => {
      setWidth(Math.min(CHAT_MAX, Math.max(CHAT_MIN, startW + (startX - ev.clientX))));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width]);

  const closeRail = () => {
    setMobileOpen(false);
    if (typeof window !== "undefined" && window.matchMedia?.(LG_QUERY).matches) {
      setDesktopOpen(false);
      writeShortChatOpen(false);
    }
  };

  const createNewSession = () => {
    const newSession: ChatSessionItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: tr("新会话", "New session"),
      messages: [],
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    setInput("");
    setError(null);
  };

  const executeAssist = async (
    instructionText: string,
    action?: "rewrite" | "deai" | "expand" | "condense" | "chat",
    selectedSnippet?: string,
  ) => {
    const trimmed = instructionText.trim();
    if (!trimmed || loading) return;

    setError(null);
    setLoading(true);

    const userMsg: ChatMessageItem = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
    };

    const nextMessages = [...activeSession.messages, userMsg];

    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeSessionId) return s;
        const newTitle =
          s.title === "当前会话" || s.title === "新会话"
            ? trimmed.slice(0, 16) + (trimmed.length > 16 ? "…" : "")
            : s.title;
        return {
          ...s,
          title: newTitle,
          messages: nextMessages,
        };
      }),
    );

    try {
      const response = await postApi<{ reply: string; candidateMarkdown?: string }>(
        `/shorts/${encodeURIComponent(shortId)}/assist`,
        {
          instruction: trimmed,
          action,
          targetWords: targetWords > 0 ? targetWords : undefined,
          selectedText: selectedSnippet,
          messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        },
      );

      const assistantMsg: ChatMessageItem = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: response.reply,
        candidateMarkdown: response.candidateMarkdown,
      };

      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== activeSessionId) return s;
          return {
            ...s,
            messages: [...s.messages, assistantMsg],
            pendingDiff: response.candidateMarkdown
              ? { candidateMarkdown: response.candidateMarkdown, reply: response.reply }
              : s.pendingDiff,
          };
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    const text = input;
    setInput("");
    await executeAssist(text, "chat");
  };

  const handleQuickAction = async (action: "rewrite" | "deai" | "expand" | "condense") => {
    let prompt = "";
    let selectedText: string | undefined;

    if (action === "rewrite") {
      const sel = typeof window !== "undefined" ? window.getSelection()?.toString().trim() : "";
      if (sel) selectedText = sel;
      prompt = buildRewritePrompt(selectedText);
    } else if (action === "deai") {
      prompt = buildDeAIPrompt();
    } else if (action === "expand") {
      prompt = buildExpandPrompt(targetWords);
    } else if (action === "condense") {
      prompt = buildCondensePrompt(targetWords);
    }

    await executeAssist(prompt, action, selectedText);
  };

  const handleApplyDiff = async () => {
    if (!activeSession.pendingDiff || readOnly) return;
    const candidate = activeSession.pendingDiff.candidateMarkdown;
    setApplying(true);
    setError(null);
    try {
      await onApplyMarkdown(candidate);
      // Clear pending diff on success
      setSessions((prev) =>
        prev.map((s) => (s.id === activeSessionId ? { ...s, pendingDiff: null } : s)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const handleDiscardDiff = () => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? { ...s, pendingDiff: null } : s)),
    );
  };

  const railOpen = lg ? desktopOpen : mobileOpen;

  const diffRows = useMemo<ReadonlyArray<DeAIDiffRow>>(() => {
    if (!activeSession.pendingDiff?.candidateMarkdown) return [];
    return lineDiffRows(markdown, activeSession.pendingDiff.candidateMarkdown);
  }, [markdown, activeSession.pendingDiff?.candidateMarkdown]);

  return (
    <>
      {/* Desktop open button */}
      {!desktopOpen && (
        <button
          type="button"
          data-testid="short-chat-open"
          onClick={() => {
            setDesktopOpen(true);
            writeShortChatOpen(true);
          }}
          className="fixed right-0 top-1/2 z-20 hidden -translate-y-1/2 items-center gap-1.5 rounded-l-lg border border-r-0 border-border/50 bg-card px-3 py-2 text-sm font-medium text-foreground shadow-sm hover:border-primary/40 hover:text-primary lg:inline-flex"
        >
          <PanelRightOpen size={16} />
          {tr("AI 对话", "AI chat")}
        </button>
      )}

      {/* Mobile open button */}
      {!mobileOpen && (
        <button
          type="button"
          data-testid="short-chat-open-mobile"
          onClick={() => setMobileOpen(true)}
          aria-label={tr("打开 AI 对话", "Open AI chat")}
          className="fixed right-0 top-1/2 z-20 inline-flex h-11 -translate-y-1/2 items-center gap-1.5 rounded-l-lg border border-r-0 border-border/50 bg-card px-3 text-sm font-medium text-foreground shadow-sm lg:hidden"
        >
          <PanelRightOpen size={16} />
          {tr("AI 对话", "AI chat")}
        </button>
      )}

      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/20 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Main chat rail */}
      <aside
        data-testid="short-chat-rail"
        data-open={railOpen ? "true" : "false"}
        className={`relative min-h-0 flex-col overflow-hidden border-l border-border/30 bg-background ${
          mobileOpen
            ? "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:flex max-lg:w-[min(100vw,440px)] max-lg:shadow-xl"
            : "max-lg:hidden"
        } ${desktopOpen ? "lg:flex lg:h-full lg:shrink-0" : "lg:hidden"}`}
        style={lg && desktopOpen ? { width } : undefined}
      >
        {/* Resize handle */}
        <div
          onMouseDown={onResizeStart}
          className="absolute left-0 top-0 z-10 hidden h-full w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 lg:block"
        />

        {/* Header toolbar */}
        <div className="flex shrink-0 items-center gap-1 border-b border-border/30 px-2 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid="short-session-switcher"
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/50"
            >
              <span className="truncate font-medium">{activeSession.title}</span>
              <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              {sessions.map((session) => (
                <DropdownMenuItem
                  key={session.id}
                  onClick={() => {
                    setActiveSessionId(session.id);
                    setError(null);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{session.title}</span>
                  {session.id === activeSessionId ? (
                    <Check size={14} className="shrink-0 text-primary" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            data-testid="short-session-new"
            onClick={createNewSession}
            aria-label={tr("新建会话", "New session")}
            title={tr("新建会话", "New session")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            data-testid="short-chat-close"
            onClick={closeRail}
            aria-label={tr("收起 AI 对话", "Hide AI chat")}
            title={tr("收起 AI 对话", "Hide AI chat")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
          >
            <PanelRightClose size={16} />
          </button>
        </div>

        {/* Quick Actions Panel */}
        <div className="shrink-0 border-b border-border/20 bg-secondary/15 p-2.5 space-y-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-muted-foreground flex items-center gap-1">
              <Sparkles size={13} className="text-primary" />
              快捷指令
            </span>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <span>目标字数:</span>
              <input
                data-testid="short-target-words"
                type="number"
                step="100"
                value={targetWords}
                onChange={(e) => setTargetWords(Math.max(100, Number(e.target.value) || 0))}
                className="w-16 rounded border border-border/60 bg-background px-1.5 py-0.5 text-center font-mono font-medium"
              />
              <span>字</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              data-testid="short-quick-rewrite"
              disabled={loading}
              onClick={() => void handleQuickAction("rewrite")}
              className="flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs font-medium hover:border-primary/40 hover:text-primary transition-colors disabled:opacity-50"
            >
              <Wand2 size={12} />
              改写段落
            </button>
            <button
              type="button"
              data-testid="short-quick-deai"
              disabled={loading}
              onClick={() => void handleQuickAction("deai")}
              className="flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs font-medium hover:border-primary/40 hover:text-primary transition-colors disabled:opacity-50"
            >
              <Sparkles size={12} />
              去 AI 味
            </button>
            <button
              type="button"
              data-testid="short-quick-expand"
              disabled={loading}
              onClick={() => void handleQuickAction("expand")}
              className="flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs font-medium hover:border-primary/40 hover:text-primary transition-colors disabled:opacity-50"
            >
              <Plus size={12} />
              扩写到 {targetWords} 字
            </button>
            <button
              type="button"
              data-testid="short-quick-condense"
              disabled={loading}
              onClick={() => void handleQuickAction("condense")}
              className="flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs font-medium hover:border-primary/40 hover:text-primary transition-colors disabled:opacity-50"
            >
              <RotateCcw size={12} />
              压缩到 {targetWords} 字
            </button>
          </div>
        </div>

        {/* Message body */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
          {activeSession.messages.length === 0 && !activeSession.pendingDiff ? (
            <div className="flex flex-col items-center justify-center py-10 text-center text-xs text-muted-foreground/80 space-y-2">
              <Sparkles size={28} className="text-primary/40" />
              <p className="font-medium text-foreground">短篇 AI 编辑助手</p>
              <p className="max-w-[260px] leading-5">
                已绑定当前短篇《{title}》。点击快捷指令改写、去 AI 味、按篇幅扩写或直接提问。
              </p>
            </div>
          ) : null}

          {activeSession.messages.map((msg) => (
            <div
              key={msg.id}
              data-testid={msg.role === "user" ? "chat-message-user" : "chat-message-assistant"}
              className={`flex flex-col space-y-1 ${
                msg.role === "user" ? "items-end" : "items-start"
              }`}
            >
              <div
                className={`max-w-[90%] rounded-xl px-3.5 py-2.5 text-xs leading-6 ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground font-medium rounded-br-none"
                    : "bg-secondary/40 text-foreground border border-border/30 rounded-bl-none whitespace-pre-wrap"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2 px-1">
              <Loader2 size={15} className="animate-spin text-primary" />
              <span>AI 思考中，分析短篇正文…</span>
            </div>
          )}

          {/* Pending Diff & Preview Card */}
          {activeSession.pendingDiff && (
            <div
              data-testid="short-ai-diff"
              className="rounded-xl border border-primary/40 bg-card p-3 shadow-md space-y-3"
            >
              <div className="flex items-center justify-between border-b border-border/30 pb-2">
                <div className="flex items-center gap-1.5 text-xs font-bold text-foreground">
                  <FileDiff size={15} className="text-primary" />
                  <span>候选修改预览（未写盘）</span>
                </div>
                <div className="text-[11px] text-muted-foreground tabular-nums">
                  {countChars(markdown)} 字 →{" "}
                  <span className="font-semibold text-foreground">
                    {countChars(activeSession.pendingDiff.candidateMarkdown)} 字
                  </span>
                </div>
              </div>

              {/* Side-by-side diff display */}
              <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border/40 bg-background/50 p-1.5">
                <p className="px-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  原正文
                </p>
                <p className="px-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  AI 候选修改
                </p>
                <div className="max-h-56 overflow-auto rounded bg-card/60 p-1 font-mono text-[11px] leading-5">
                  {diffRows.map((row, index) => (
                    <div
                      key={`l-${index}`}
                      className={`whitespace-pre-wrap px-1 rounded ${
                        row.left?.kind === "del"
                          ? "bg-destructive/15 text-destructive"
                          : "text-muted-foreground"
                      }`}
                    >
                      {row.left?.text ?? " "}
                    </div>
                  ))}
                </div>
                <div className="max-h-56 overflow-auto rounded bg-card/60 p-1 font-mono text-[11px] leading-5">
                  {diffRows.map((row, index) => (
                    <div
                      key={`r-${index}`}
                      className={`whitespace-pre-wrap px-1 rounded ${
                        row.right?.kind === "add"
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 font-medium"
                          : "text-muted-foreground"
                      }`}
                    >
                      {row.right?.text ?? " "}
                    </div>
                  ))}
                </div>
              </div>

              {readOnly && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  ⚠️ 已发布短篇为只读状态，不可应用修改。
                </p>
              )}

              {/* Action buttons: Apply vs Discard */}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  data-testid="short-ai-discard"
                  disabled={applying}
                  onClick={handleDiscardDiff}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-secondary/40 hover:text-foreground transition-colors disabled:opacity-40"
                >
                  放弃
                </button>
                <button
                  type="button"
                  data-testid="short-ai-apply"
                  disabled={readOnly || applying}
                  onClick={() => void handleApplyDiff()}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground hover:opacity-90 shadow-sm transition-opacity disabled:opacity-40"
                >
                  {applying ? (
                    <>
                      <Loader2 size={13} className="animate-spin" />
                      应用中…
                    </>
                  ) : (
                    <>
                      <Check size={13} />
                      应用修改
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-2.5">
              {error}
            </p>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Bottom input area */}
        <div className="shrink-0 border-t border-border/30 bg-background p-2.5">
          <div className="flex items-end gap-1.5 rounded-xl border border-border/60 bg-secondary/20 p-1.5 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10 transition-all">
            <textarea
              data-testid="short-chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="向 AI 提问或提出改写要求…（Enter 发送）"
              rows={2}
              className="flex-1 resize-none bg-transparent px-2 py-1 text-xs leading-5 text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
            />
            <button
              type="button"
              data-testid="short-chat-send"
              disabled={loading || !input.trim()}
              onClick={() => void handleSend()}
              aria-label="发送"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
