import { useState } from "react";
import { fetchJson, useApi, postApi } from "../hooks/use-api";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { ChapterWorkspacePanel } from "../components/ChapterWorkspacePanel";
import {
  ChevronLeft,
  Check,
  X,
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
  const { data, loading, error, refetch } = useApi<ChapterData>(
    `/books/${bookId}/chapters/${chapterNumber}`,
  );
  const { data: bookData } = useApi<BookChapterList>(`/books/${bookId}`);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);

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

  const handleApprove = async () => {
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/approve`);
      nav.toBook(bookId);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Approve failed");
    }
  };

  const handleReject = async () => {
    try {
      await postApi(`/books/${bookId}/chapters/${chapterNumber}/reject`);
      nav.toBook(bookId);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Reject failed");
    }
  };

  const paragraphs = body.split(/\n\n+/).filter(Boolean);

  const { prev, next } = adjacentChapters(bookData?.chapters, chapterNumber);
  const toChapter = nav.toChapter;

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
            <button
              onClick={handleStartEdit}
              className={`${ACTION} bg-secondary text-muted-foreground hover:text-primary hover:bg-primary/10 border border-border/50`}
            >
              <Pencil size={14} />
              {t("reader.edit")}
            </button>
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

      <ChapterWorkspacePanel
        key={`${chapterNumber}-${workspaceRevision}`}
        bookId={bookId}
        chapterNumber={chapterNumber}
        t={t}
        onChapterChanged={refetch}
        onChapterDeleted={() => nav.toBook(bookId)}
      />

      {/* Manuscript Sheet */}
      <div className="paper-sheet rounded-2xl px-4 py-6 sm:p-8 md:p-16 lg:p-24 shadow-2xl shadow-primary/5 min-h-[80vh] relative overflow-hidden">
        {/* Physical Paper Details */}
        <div className="absolute top-0 left-8 w-px h-full bg-primary/5 hidden md:block" />
        <div className="absolute top-0 right-8 w-px h-full bg-primary/5 hidden md:block" />

        <header className="mb-8 md:mb-16 text-center">
          <div className="flex items-center justify-center gap-2 text-muted-foreground/30 mb-4 md:mb-8 select-none">
            <div className="h-px w-12 bg-border/40" />
            <BookOpen size={20} />
            <div className="h-px w-12 bg-border/40" />
          </div>
          <h1 className="text-4xl md:text-5xl max-sm:text-[1.75rem]! font-serif font-medium italic text-foreground tracking-tight leading-tight break-words">
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
            className="w-full min-h-[60vh] bg-transparent font-serif text-lg leading-[1.8] text-foreground/90 focus:outline-none resize-none border border-border/30 rounded-lg p-3 sm:p-6 focus:border-primary/40 focus:ring-2 focus:ring-primary/10 transition-all"
            autoFocus
          />
        ) : (
          <article data-testid="chapter-body" className="prose prose-zinc dark:prose-invert max-w-none">
            {paragraphs.map((para, i) => (
              <p key={i} className="font-serif text-lg md:text-xl leading-[1.8] text-foreground/90 mb-5 md:mb-8 break-words first-letter:text-2xl first-letter:font-bold first-letter:text-primary/40">
                {para}
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
    </div>
  );
}
