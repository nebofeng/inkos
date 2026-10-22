import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, useApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { useIsMobile, useMobileSelectionChrome } from "../hooks/use-mobile";
import { useLongTask } from "../hooks/use-long-task";
import { useTextSelection, type TextSelectionState } from "../hooks/use-text-selection";
import { ChapterWorkspacePanel } from "../components/ChapterWorkspacePanel";
import { RewriteModal } from "../components/RewriteModal";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { MobileNoteSheet } from "../components/notes/MobileNoteSheet";
import { MobileSelectionCapsule } from "../components/notes/MobileSelectionCapsule";
import { NotePanel } from "../components/notes/NotePanel";
import { RailTabHeader } from "../components/notes/RailTabHeader";
import { SelectionFloatingBar } from "../components/notes/SelectionFloatingBar";
import { TaskProgressBanner } from "../components/notes/TaskProgressBanner";
import { CANCELLED_TOAST, TAP_TARGET_CLASS } from "../components/notes/note-panel-ui";
import { NOTE_PLACEHOLDER, SAVE_LABEL } from "../components/notes/selection-ui";
import { createAnnotation, listAnnotations, type ChapterNote } from "../lib/annotation-client";
import { resolveAnnotationSelector } from "../lib/note-panel-logic";
import { cn } from "../lib/utils";
import {
  HIGHLIGHT_CLASS,
  NOTE_ANCHOR_SCROLL_MARGIN_CLASS,
  PARAGRAPH_FALLBACK_TOAST,
  RIGHT_RAIL_WIDTH_CLASS,
  highlightsFromNotes,
  noteAnchorId,
  paragraphVisibleRanges,
  railNotesLabel,
  safeChapterReaderVisible,
  splitHighlightedText,
  type RailTab,
} from "./chapter-reader-notes";
import {
  ChevronLeft,
  List,
  RotateCcw,
  BookOpen,
  CheckCircle2,
  XCircle,
  Hash,
  Type,
  Clock,
  Pencil,
  Save,
  Eye,
  ChevronRight,
} from "lucide-react";

interface ChapterData {
  readonly chapterNumber: number;
  readonly filename: string;
  readonly content: string;
}

interface Nav {
  toBook: (id: string) => void;
  toDashboard: () => void;
  /** Optional: enables previous / next chapter links (handy when reading on a phone). */
  toChapter?: (bookId: string, chapterNumber: number) => void;
}

interface BookChapterList {
  readonly chapters: ReadonlyArray<{ readonly number: number }>;
}

/** Previous / next chapter numbers that actually exist, for reader navigation. */
export function adjacentChapters(
  chapters: ReadonlyArray<{ readonly number: number }> | undefined,
  current: number,
): { prev: number | null; next: number | null } {
  if (!chapters?.length) return { prev: current > 1 ? current - 1 : null, next: null };
  const numbers = chapters.map((chapter) => chapter.number).sort((a, b) => a - b);
  const prev = numbers.filter((n) => n < current).at(-1) ?? null;
  const next = numbers.find((n) => n > current) ?? null;
  return { prev, next };
}

// Phone sizing: tap targets >= 44px below md; desktop keeps the compact pills.
const ACTION = "flex min-h-11 items-center justify-center gap-2 px-4 py-2 text-xs max-md:text-[15px]! md:min-h-0 md:justify-start font-bold rounded-xl transition-all";

export function ChapterReader({ bookId, chapterNumber, nav, theme, t }: {
  bookId: string;
  chapterNumber: number;
  nav: Nav;
  theme: Theme;
  t: TFunction;
}) {
  const c = useColors(theme);
  void c;
  const isMobile = useIsMobile();
  const selectionChromeMobile = useMobileSelectionChrome();
  const { data, loading, error, refetch } = useApi<ChapterData>(
    `/books/${bookId}/chapters/${chapterNumber}`,
  );
  const { data: bookData } = useApi<BookChapterList>(`/books/${bookId}`);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [railTab, setRailTab] = useState<RailTab>("chat");
  const [notes, setNotes] = useState<ChapterNote[]>([]);
  const [notesRevision, setNotesRevision] = useState(0);
  const [highlightNoteId, setHighlightNoteId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [mobileSheet, setMobileSheet] = useState<"compose" | "notes" | null>(null);
  const [mobileDraft, setMobileDraft] = useState("");
  const [selectionOpen, setSelectionOpen] = useState(true);
  const [pinnedSelection, setPinnedSelection] = useState<TextSelectionState | null>(null);
  const bodyRef = useRef<HTMLElement | null>(null);
  const reworkTask = useLongTask({ charCount: data?.content.length ?? 0 });
  const { selection, dismiss } = useTextSelection(bodyRef, { sticky: selectionChromeMobile });

  const reloadNotes = useCallback(async () => {
    const listed = await listAnnotations(bookId, chapterNumber);
    setNotes([...listed.notes]);
  }, [bookId, chapterNumber]);

  useEffect(() => {
    let cancelled = false;
    void listAnnotations(bookId, chapterNumber)
      .then((listed) => {
        if (!cancelled) setNotes([...listed.notes]);
      })
      .catch(() => {
        if (!cancelled) setNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, chapterNumber, notesRevision, data?.content]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setSelectionOpen(true);
  }, [selection?.start, selection?.end, selection?.text]);

  const handleStartEdit = () => {
    if (!data) return;
    setEditContent(data.content);
    setEditing(true);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditContent("");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      setEditing(false);
      refetch();
      setWorkspaceRevision((revision) => revision + 1);
      setNotesRevision((revision) => revision + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) return (
    <div className="flex flex-col items-center justify-center py-32 space-y-4">
      <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      <span className="text-sm text-muted-foreground">{t("reader.openingManuscript")}</span>
    </div>
  );

  if (error) return <div className="text-destructive p-8 bg-destructive/5 rounded-xl border border-destructive/20">Error: {error}</div>;
  if (!data) return null;

  // Split markdown content into title and body
  const lines = data.content.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine?.replace(/^#\s*/, "") ?? `Chapter ${chapterNumber}`;
  const body = lines
    .filter((l) => l !== titleLine)
    .join("\n")
    .trim();

  const handleRewrite = async (brief: string) => {
    try {
      const result = await reworkTask.run(async ({ signal }) =>
        fetchJson(`/books/${bookId}/rewrite/${chapterNumber}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brief: brief.trim() || undefined }),
          signal,
        }),
      );
      if (!result) {
        setToast(CANCELLED_TOAST);
        return;
      }
      refetch();
      setWorkspaceRevision((revision) => revision + 1);
      setNotesRevision((revision) => revision + 1);
      setRewriteOpen(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Rewrite failed");
    }
  };

  const handleApprove = async () => {
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNumber}/approve`, { method: "POST" });
      nav.toBook(bookId);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Approve failed");
    }
  };

  const handleReject = async () => {
    try {
      await fetchJson(`/books/${bookId}/chapters/${chapterNumber}/reject`, { method: "POST" });
      nav.toBook(bookId);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Reject failed");
    }
  };

  const paragraphs = body.split(/\n\n+/).filter(Boolean);
  const visibleIndex = safeChapterReaderVisible(data.content);
  const highlights = highlightsFromNotes(notes, visibleIndex);
  const paraRanges = paragraphVisibleRanges(paragraphs);

  const { prev, next } = adjacentChapters(bookData?.chapters, chapterNumber);
  const toChapter = nav.toChapter;
  const liveSelection = !editing && selectionOpen ? (pinnedSelection ?? selection) : null;

  const hideSelectionChrome = () => {
    setSelectionOpen(false);
  };

  const dismissMobileSelection = () => {
    setSelectionOpen(false);
    setPinnedSelection(null);
    dismiss();
  };

  const focusNote = (noteId: string) => {
    setRailTab("notes");
    setHighlightNoteId(noteId);
    if (isMobile) setMobileSheet("notes");
  };

  const locateInBody = (note: ChapterNote) => {
    document.getElementById(noteAnchorId(note.id))?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const addNoteFromSelection = async (comment: string, start: number, end: number) => {
    const resolved = resolveAnnotationSelector({
      source: data.content,
      visibleStart: start,
      visibleEnd: end,
      renderer: "chapter-reader",
    });
    if (!resolved) return;
    await createAnnotation(bookId, chapterNumber, {
      comment,
      start: resolved.selector.start,
      end: resolved.selector.end,
      origin: "user",
    });
    if (resolved.usedParagraphFallback) setToast(PARAGRAPH_FALLBACK_TOAST);
    setNotesRevision((revision) => revision + 1);
    setRailTab("notes");
    dismissMobileSelection();
    window.getSelection()?.removeAllRanges();
    await reloadNotes();
  };

  const notePanel = (
    <NotePanel
      key={`${bookId}-${chapterNumber}-${notesRevision}`}
      bookId={bookId}
      chapterNum={chapterNumber}
      highlightNoteId={highlightNoteId}
      onLocate={locateInBody}
      onApplied={() => {
        refetch();
        setWorkspaceRevision((revision) => revision + 1);
        setNotesRevision((revision) => revision + 1);
      }}
    />
  );

  const chatPane = (
    <div
      className="flex min-h-40 flex-1 flex-col justify-center rounded-xl border border-dashed border-zinc-200 px-4 py-8 text-center text-sm text-zinc-400"
      data-testid="chapter-chat-placeholder"
    >
      {chatDraft ? (
        <p className="text-left text-zinc-600">
          选区已带到对话：
          <span className="mt-2 block rounded-md bg-zinc-50 p-2 text-xs text-zinc-700">{chatDraft}</span>
        </p>
      ) : (
        <p>本章对话将显示在这里</p>
      )}
    </div>
  );

  return (
    <div className="w-full space-y-6 md:space-y-10 fade-in">
      {/* Navigation & Actions. While editing on a phone this bar sticks to the
          top of the scroll area so Save stays reachable above the keyboard. */}
      <div
        data-testid="chapter-toolbar"
        className={`flex flex-col md:flex-row md:items-center justify-between gap-3 md:gap-6 ${
          editing
            ? "sticky top-0 z-20 -mx-3 px-3 py-2 bg-background/95 backdrop-blur border-b border-border/40 sm:-mx-6 sm:px-6 md:static md:mx-0 md:px-0 md:py-0 md:bg-transparent md:backdrop-blur-none md:border-0"
            : ""
        }`}
      >
        <nav className={`${editing ? "hidden md:flex" : "flex"} min-w-0 items-center gap-1 md:gap-2 text-[13px] max-md:text-[15px]! font-medium text-muted-foreground`}>
          <button
            onClick={nav.toDashboard}
            className="hover:text-primary transition-colors flex shrink-0 items-center justify-center gap-1 min-h-11 min-w-11 md:min-h-0 md:min-w-0 px-1 md:px-0"
          >
            {t("bread.books")}
          </button>
          <span className="text-border">/</span>
          <button
            onClick={() => nav.toBook(bookId)}
            className="hover:text-primary transition-colors truncate min-w-0 max-w-[45vw] md:max-w-[120px] min-h-11 md:min-h-0 px-1 md:px-0"
          >
            {bookId}
          </button>
          <span className="text-border">/</span>
          <span className="text-foreground flex shrink-0 items-center gap-1">
            <Hash size={12} />
            {chapterNumber}
          </span>
        </nav>

        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <button
            onClick={() => nav.toBook(bookId)}
            className={`${editing ? "hidden sm:flex" : ""} ${ACTION} bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 border border-border/50`}
          >
            <List size={14} />
            {t("reader.backToList")}
          </button>

          {/* Edit / Preview toggle */}
          {editing ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className={`${ACTION} bg-primary text-primary-foreground hover:scale-105 active:scale-95 shadow-sm disabled:opacity-50`}
              >
                {saving ? <div className="w-3.5 h-3.5 border-2 border-primary-foreground/20 border-t-primary-foreground rounded-full animate-spin" /> : <Save size={14} />}
                {saving ? t("book.saving") : t("book.save")}
              </button>
              <button
                onClick={handleCancelEdit}
                className={`${ACTION} bg-secondary text-muted-foreground hover:text-foreground border border-border/50`}
              >
                <Eye size={14} />
                {t("reader.preview")}
              </button>
            </>
          ) : (
            <>
            <button
              onClick={handleStartEdit}
              className={`${ACTION} bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 border border-border/50`}
            >
              <Pencil size={14} />
              {t("reader.edit")}
            </button>
            <button
              onClick={() => setRewriteOpen(true)}
              disabled={reworkTask.running}
              className={`${ACTION} bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 border border-border/50 disabled:opacity-50`}
            >
              <RotateCcw size={14} className={reworkTask.running ? "animate-spin" : ""} />
              {reworkTask.running ? t("reader.rewriting") : t("reader.rewriteFromBrief")}
            </button>
            <button
              type="button"
              data-testid="mobile-notes-entry"
              onClick={() => setMobileSheet("notes")}
              className={`${ACTION} bg-secondary text-muted-foreground hover:text-foreground border border-border/50 md:hidden`}
            >
              {railNotesLabel(notes.length)}
            </button>
            </>
          )}

          <button
            onClick={handleApprove}
            className={`${editing ? "hidden sm:flex" : ""} ${ACTION} bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500 hover:text-white border border-emerald-500/20 shadow-sm`}
          >
            <CheckCircle2 size={14} />
            {t("reader.approve")}
          </button>
          <button
            onClick={handleReject}
            className={`${editing ? "hidden sm:flex" : ""} ${ACTION} bg-destructive/10 text-destructive hover:bg-destructive hover:text-white border border-destructive/20 shadow-sm`}
          >
            <XCircle size={14} />
            {t("reader.reject")}
          </button>
        </div>
      </div>

      {reworkTask.running ? (
        <TaskProgressBanner
          kind="chapter_rework"
          estimateMs={reworkTask.estimateMs}
          elapsedSeconds={Math.floor(reworkTask.elapsedMs / 1000)}
          running={reworkTask.running}
          onCancel={reworkTask.cancel}
        />
      ) : null}

      <ChapterWorkspacePanel
        key={`${chapterNumber}-${workspaceRevision}`}
        bookId={bookId}
        chapterNumber={chapterNumber}
        t={t}
        onChapterChanged={refetch}
        onChapterDeleted={() => nav.toBook(bookId)}
      />

      <div className="flex w-full items-start gap-6">
      {/* Manuscript Sheet */}
      <div className="min-w-0 flex-1 bg-transparent border-0 shadow-none rounded-none px-5 py-6 sm:py-10 min-h-[80vh] relative overflow-hidden">
        {/* Physical Paper Details */}
        <div className="absolute top-0 left-8 w-px h-full bg-primary/5 hidden md:block" />
        <div className="absolute top-0 right-8 w-px h-full bg-primary/5 hidden md:block" />

        <header className="mb-8 md:mb-16 text-center">
          <div className="flex items-center justify-center gap-2 text-muted-foreground/30 mb-4 md:mb-8 select-none">
            <div className="h-px w-12 bg-border/40" />
            <BookOpen size={20} />
            <div className="h-px w-12 bg-border/40" />
          </div>
          <h1 className="text-4xl md:text-5xl max-sm:text-[1.75rem]! font-serif font-normal not-italic [text-wrap:balance] [font-variant-numeric:lining-nums] text-foreground tracking-tight leading-tight break-words">
            {title}
          </h1>
          <div className="mt-4 md:mt-8 flex items-center justify-center gap-4 text-[10px] max-md:text-[12px]! font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
            <span>{t("reader.manuscriptPage")}</span>
            <span className="text-border">·</span>
            <span>{chapterNumber.toString().padStart(2, '0')}</span>
          </div>
        </header>

        {editing ? (
          <textarea
            data-testid="chapter-editor"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="w-full min-h-[60vh] bg-transparent font-serif text-[18px] sm:text-[19px] 2xl:text-[20px] leading-[1.8]! text-foreground/90 focus:outline-none resize-none border border-border/30 rounded-lg p-3 sm:p-6 focus:border-primary/40 focus:ring-2 focus:ring-primary/10 transition-all"
            autoFocus
          />
        ) : (
          <article ref={bodyRef} data-testid="chapter-body" className="prose prose-zinc dark:prose-invert mx-auto max-w-[36em]">
            {paragraphs.map((para, i) => (
              <p key={i} className="font-serif text-[18px] sm:text-[19px] 2xl:text-[20px] leading-[1.8]! text-foreground/90 mb-[0.9em] break-words first-letter:text-2xl first-letter:font-bold first-letter:text-primary/40">
                {splitHighlightedText(para, paraRanges[i]?.start ?? 0, highlights).map((segment, j) =>
                  segment.noteId && segment.status ? (
                    <span
                      key={`${segment.noteId}-${j}`}
                      id={segment.anchor ? noteAnchorId(segment.noteId) : undefined}
                      data-note-id={segment.noteId}
                      data-note-status={segment.status}
                      className={cn(HIGHLIGHT_CLASS[segment.status], NOTE_ANCHOR_SCROLL_MARGIN_CLASS)}
                      onClick={() => focusNote(segment.noteId!)}
                    >
                      {segment.text}
                    </span>
                  ) : (
                    <span key={j}>{segment.text}</span>
                  ),
                )}
              </p>
            ))}
          </article>
        )}

        <footer className="mt-12 md:mt-24 pt-8 md:pt-12 border-t border-border/20 flex flex-col items-center gap-6 text-center">
          <div className="flex flex-wrap items-center justify-center gap-2 md:gap-4 text-xs font-medium text-muted-foreground">
             <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary/50">
               <Type size={14} className="text-primary/60" />
               <span>{body.length.toLocaleString()} {t("reader.characters")}</span>
             </div>
             <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary/50">
               <Clock size={14} className="text-primary/60" />
               <span>{Math.ceil(body.length / 500)} {t("reader.minRead")}</span>
             </div>
          </div>
          <p className="text-[10px] max-md:text-[12px]! uppercase tracking-widest text-muted-foreground/40 font-bold">{t("reader.endOfChapter")}</p>
        </footer>
      </div>

      <aside
        data-testid="chapter-right-rail"
        className={cn(
          "sticky top-4 hidden h-[calc(100vh-6rem)] shrink-0 flex-col gap-3 rounded-2xl border border-zinc-200/80 bg-white p-3 md:flex",
          RIGHT_RAIL_WIDTH_CLASS,
        )}
      >
        <RailTabHeader active={railTab} noteCount={notes.length} onChange={setRailTab} />
        <div className="min-h-0 flex-1 overflow-hidden">
          {railTab === "notes" ? notePanel : chatPane}
        </div>
      </aside>
      </div>

      {/* Footer Navigation */}
      <div className="flex flex-wrap justify-between items-center gap-2 py-4 md:py-8">
        {chapterNumber > 1 ? (
          <button
            onClick={() => nav.toBook(bookId)}
            className="flex min-h-11 md:min-h-0 items-center gap-2 text-sm font-bold text-muted-foreground hover:text-primary transition-all group"
          >
            <RotateCcw size={16} className="group-hover:-rotate-45 transition-transform" />
            {t("reader.chapterList")}
          </button>
        ) : (
          <div />
        )}
        {toChapter && (prev !== null || next !== null) && (
          <div className="flex gap-2">
            {prev !== null && (
              <button
                data-testid="chapter-prev"
                onClick={() => toChapter(bookId, prev)}
                className={`${ACTION} bg-secondary text-muted-foreground hover:text-foreground border border-border/50`}
              >
                <ChevronLeft size={14} />
                {t("chapter.label").replace("{n}", String(prev))}
              </button>
            )}
            {next !== null && (
              <button
                data-testid="chapter-next"
                onClick={() => toChapter(bookId, next)}
                className={`${ACTION} bg-secondary text-foreground hover:text-primary border border-border/50`}
              >
                {t("chapter.label").replace("{n}", String(next))}
                <ChevronRight size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <RewriteModal
        open={rewriteOpen}
        language={t("nav.connected") === "已连接" ? "zh" : "en"}
        busy={reworkTask.running}
        onOpenChange={setRewriteOpen}
        onConfirm={(brief) => { void handleRewrite(brief); }}
      />

      {!editing && liveSelection?.rect && !selectionChromeMobile ? (
        <SelectionFloatingBar
          rect={liveSelection.rect}
          selectedText={liveSelection.text}
          onAddNote={(comment) => {
            void addNoteFromSelection(comment, liveSelection.start, liveSelection.end);
          }}
          onAskAi={(text) => {
            setChatDraft(text);
            setRailTab("chat");
            hideSelectionChrome();
          }}
          onClose={hideSelectionChrome}
        />
      ) : null}

      {!editing && liveSelection && selectionChromeMobile && mobileSheet !== "compose" ? (
        <MobileSelectionCapsule
          onClick={() => {
            setPinnedSelection(liveSelection);
            setMobileSheet("compose");
          }}
        />
      ) : null}

      <MobileNoteSheet
        open={selectionChromeMobile && mobileSheet === "compose"}
        title="加备注"
        onClose={() => {
          setMobileSheet(null);
          setMobileDraft("");
          dismissMobileSelection();
        }}
      >
        <p className="mb-2 text-xs text-zinc-500">{liveSelection?.text ?? ""}</p>
        <Textarea
          value={mobileDraft}
          rows={4}
          placeholder={NOTE_PLACEHOLDER}
          onChange={(event) => setMobileDraft(event.target.value)}
          className="min-h-24 bg-white text-sm"
        />
        <Button
          type="button"
          disabled={!mobileDraft.trim() || !liveSelection}
          className={cn(TAP_TARGET_CLASS, "mt-3 h-11 w-full")}
          onClick={() => {
            if (!liveSelection) return;
            void addNoteFromSelection(mobileDraft.trim(), liveSelection.start, liveSelection.end).then(() => {
              setMobileDraft("");
              setMobileSheet("notes");
            });
          }}
        >
          {SAVE_LABEL}
        </Button>
      </MobileNoteSheet>

      <MobileNoteSheet
        open={isMobile && mobileSheet === "notes"}
        title={railNotesLabel(notes.length)}
        onClose={() => setMobileSheet(null)}
      >
        {notePanel}
      </MobileNoteSheet>

      {toast ? (
        <div
          className="fixed bottom-8 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-white shadow-lg"
          data-testid="chapter-note-toast"
          role="status"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
