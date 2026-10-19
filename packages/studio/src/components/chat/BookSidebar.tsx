import { useState, useEffect, useCallback } from "react";
import type { Theme } from "../../hooks/use-theme";
import type { TFunction } from "../../hooks/use-i18n";
import type { SSEMessage } from "../../hooks/use-sse";
import { useChatStore } from "../../store/chat";
import { fetchJson } from "../../hooks/use-api";
import { tr } from "../../lib/app-language";
import { ArrowLeft, Loader2, Pencil, Save, X } from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { ProgressSection } from "../sidebar/ProgressSection";
import { FoundationSection } from "../sidebar/FoundationSection";
import { SummarySection } from "../sidebar/SummarySection";
import { ChaptersSection } from "../sidebar/ChaptersSection";
import { CharacterSection } from "../sidebar/CharacterSection";
import { FrontmatterCards } from "../sidebar/FrontmatterCards";
import { PendingHooksView } from "../sidebar/PendingHooksView";
import {
  FOUNDATION_FILE_LABELS,
  frontmatterToCards,
  hasTableRows,
  presentCurrentState,
  relabelOkrJargon,
  roleFromPath,
  stripStructuralMarkers,
  type TruthFrontmatter,
} from "../../lib/truth-display";

export interface BookSidebarProps {
  readonly bookId: string;
  readonly theme: Theme;
  readonly t: TFunction;
  readonly sse: { messages: ReadonlyArray<SSEMessage>; connected: boolean };
}

const streamdownPlugins = { cjk };

// Friendly header label for an opened truth file: character files show the
// character's name, foundation files their friendly label, everything else its
// path as a last resort.
function artifactLabel(file: string): string {
  return roleFromPath(file)?.name ?? FOUNDATION_FILE_LABELS[file] ?? file;
}

// Read-mode body for an opened file. A few files need reader-friendly handling
// instead of raw markdown: pending_hooks.md (a wide tracking table) renders as
// cards, current_state.md hides its engineering seed note, and files with YAML
// frontmatter (story_frame.md) render structured cards above clean prose.
function renderTruthBody(
  file: string | null,
  content: string,
  frontmatter: TruthFrontmatter | null,
  body: string | null,
) {
  if (file === "pending_hooks.md") {
    return <PendingHooksView content={content} />;
  }
  if (file === "current_state.md") {
    const { isEmpty, body: stateBody } = presentCurrentState(content);
    return isEmpty ? (
      <p className="text-[14px] leading-6 text-muted-foreground/60 italic">
        还没有运行状态。开始写作后，每写完一章这里会自动记录最新的故事进展。
      </p>
    ) : (
      <Streamdown plugins={streamdownPlugins} mode="static">{stateBody}</Streamdown>
    );
  }
  if (file === "emotional_arcs.md" && !hasTableRows(content)) {
    return (
      <p className="text-[14px] leading-6 text-muted-foreground/60 italic">
        还没有情感弧线记录。开始写作后，这里会记录角色在各章的情绪变化。
      </p>
    );
  }
  return (
    <>
      <FrontmatterCards cards={frontmatterToCards(frontmatter)} />
      <Streamdown plugins={streamdownPlugins} mode="static">
        {relabelOkrJargon(stripStructuralMarkers(body ?? content))}
      </Streamdown>
    </>
  );
}

function ArtifactView({ bookId }: { readonly bookId: string }) {
  const artifactFile = useChatStore((s) => s.artifactFile);
  const artifactChapter = useChatStore((s) => s.artifactChapter);
  const closeArtifact = useChatStore((s) => s.closeArtifact);
  const [content, setContent] = useState<string | null>(null);
  const [frontmatter, setFrontmatter] = useState<TruthFrontmatter | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  const isChapter = artifactChapter !== null;
  const label = isChapter
    ? `第 ${artifactChapter} 章`
    : artifactFile ? artifactLabel(artifactFile) : "";

  useEffect(() => {
    setEditing(false);
    setLoading(true);
    setFrontmatter(null);
    setBody(null);
    if (isChapter) {
      fetchJson<{ content: string }>(`/books/${bookId}/chapters/${artifactChapter}`)
        .then((data) => setContent(data.content ?? ""))
        .catch(() => setContent(null))
        .finally(() => setLoading(false));
    } else if (artifactFile) {
      fetchJson<{ content: string | null; frontmatter?: TruthFrontmatter; body?: string }>(
        `/books/${bookId}/truth/${artifactFile}`,
      )
        .then((data) => {
          setContent(data.content ?? "");
          setFrontmatter(data.frontmatter ?? null);
          setBody(data.body ?? null);
        })
        .catch(() => setContent(null))
        .finally(() => setLoading(false));
    }
  }, [bookId, artifactFile, artifactChapter, isChapter]);

  const handleEdit = useCallback(() => {
    setEditContent(content ?? "");
    setEditing(true);
  }, [content]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (isChapter) {
        await fetchJson(`/books/${bookId}/chapters/${artifactChapter}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        });
      } else if (artifactFile) {
        await fetchJson(`/books/${bookId}/truth/${artifactFile}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        });
      }
      setContent(editContent);
      setEditing(false);
    } catch {
      // keep editing state on error
    } finally {
      setSaving(false);
    }
  }, [bookId, artifactFile, artifactChapter, isChapter, editContent]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/20 px-4 py-3 sm:px-8">
        <button
          type="button"
          onClick={closeArtifact}
          aria-label={tr("返回目录", "Back to contents")}
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <span className="min-w-0 flex-1 truncate font-serif text-lg leading-7">{label}</span>
        {!loading && content !== null && !editing && (
          <button
            type="button"
            onClick={handleEdit}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/50 px-3 text-sm text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors"
          >
            <Pencil size={14} />
            {tr("编辑", "Edit")}
          </button>
        )}
        {editing && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {tr("保存", "Save")}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              aria-label={tr("取消编辑", "Cancel editing")}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 size={18} className="text-muted-foreground animate-spin" />
          </div>
        ) : content === null ? (
          <p className="px-8 py-6 text-[15px] leading-7 text-muted-foreground/50 italic">{tr("文件不存在", "File not found")}</p>
        ) : editing ? (
          <div className="mx-auto w-full max-w-none px-4 py-6 pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:py-10 min-[1680px]:px-8">
            <textarea
              data-testid="book-manuscript-editor"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="min-h-[70vh] w-full resize-none rounded-none border-0 bg-transparent px-0 py-6 font-serif text-[18px] sm:text-[19px] 2xl:text-[20px] leading-[1.8]! text-foreground/90 outline-none shadow-none sm:py-10"
            />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-none px-4 py-6 pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:py-10 min-[1680px]:px-8">
            <article data-testid="book-manuscript-body" className="mx-auto max-w-[36em] min-[1680px]:max-w-[40em] w-full bg-transparent border-0 shadow-none rounded-none py-6 sm:py-10 font-serif text-[18px] sm:text-[19px] 2xl:text-[20px] leading-[1.8]! text-foreground/90 selection:bg-primary/20 [&_p]:mb-[0.9em] [&_h1]:font-semibold [&_h1]:not-italic [&_h1]:[font-variant-numeric:lining-nums_tabular-nums]">
              {renderTruthBody(isChapter ? null : artifactFile, content, frontmatter, body)}
            </article>
          </div>
        )}
      </div>
    </div>
  );
}

function PanelView({ bookId, theme: _theme, t, sse }: BookSidebarProps) {
  const isZh = t("nav.connected") === "\u5DF2\u8FDE\u63A5";

  // Show writing indicator only during pipeline operations (write/audit/revise)
  const [activeOp, setActiveOp] = useState<string | null>(null);
  useEffect(() => {
    const latest = sse.messages;
    if (latest.length === 0) return;
    const last = latest[latest.length - 1];
    if (last.event === "write:start") setActiveOp("write");
    else if (last.event === "tool:start") {
      const data = last.data as { tool?: string; args?: { agent?: string } } | null;
      if (data?.tool === "sub_agent") {
        const agent = data.args?.agent;
        if (agent === "writer") setActiveOp("write");
        else if (agent === "auditor") setActiveOp("audit");
        else if (agent === "reviser") setActiveOp("revise");
      }
    } else if (last.event === "write:complete" || last.event === "tool:end") {
      setActiveOp(null);
    }
  }, [sse.messages]);

  const OP_LABELS: Record<string, string> = {
    write: isZh ? "正在写作中..." : "Writing...",
    audit: isZh ? "正在审计中..." : "Auditing...",
    revise: isZh ? "正在修订中..." : "Revising...",
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-8 sm:py-8">
        <header className="mb-1">
          <h2 className="font-serif text-2xl text-foreground">{isZh ? "书稿" : "Manuscript"}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {isZh
              ? "章节、故事基石和卷纲在这里。点开即可阅读和编辑。需要让 AI 写的时候，用右侧对话。"
              : "Chapters, story foundation, and the volume map live here. Open one to read or edit. Use the chat on the right when you want the AI to write."}
          </p>
        </header>
        {activeOp && (
          <div className="flex items-center gap-2 rounded-lg border border-primary/10 bg-primary/5 px-3 py-2">
            <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
            <span className="text-[14px] leading-5 font-medium text-primary">
              {OP_LABELS[activeOp] ?? activeOp}
            </span>
          </div>
        )}
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-4">
            <ProgressSection sse={sse} />
            <ChaptersSection bookId={bookId} isZh={isZh} />
            <CharacterSection bookId={bookId} />
          </div>
          <div className="flex flex-col gap-4">
            <FoundationSection bookId={bookId} />
            <SummarySection bookId={bookId} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function BookSidebar({ bookId, theme, t, sse }: BookSidebarProps) {
  const sidebarView = useChatStore((s) => s.sidebarView);

  // The open chapter or outline belongs to one book. Entering another book
  // returns to that book's contents instead of loading the previous file.
  useEffect(() => {
    useChatStore.getState().closeArtifact();
  }, [bookId]);

  return (
    <section data-testid="book-manuscript" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {sidebarView === "artifact" ? (
        <ArtifactView bookId={bookId} />
      ) : (
        <PanelView bookId={bookId} theme={theme} t={t} sse={sse} />
      )}
    </section>
  );
}
