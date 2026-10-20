import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useLongTask } from "@/hooks/use-long-task";
import {
  applyNoteRevise,
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  noteRevise,
  updateAnnotation,
  type ChapterNote,
  type NoteReviseApplyResponse,
} from "@/lib/annotation-client";
import { countNotesByFilter, filterNotes } from "@/lib/note-panel-logic";
import { DiffReviewCard } from "./DiffReviewCard";
import { NoteCard } from "./NoteCard";
import { TaskProgressBanner } from "./TaskProgressBanner";
import {
  APPLY_SUCCESS_TOAST,
  CANCELLED_TOAST,
  DELETE_TOAST,
  NOTE_FILTER_KEYS,
  NOTE_REVISE_DEFAULT_MS,
  OVERLAP_LABEL,
  TAP_TARGET_CLASS,
  UNDO_LABEL,
  acceptSelectedLabel,
  batchReviseLabel,
  canAcceptAllNotes,
  canAcceptSelectedNotes,
  filterButtonLabel,
  isReviewMode,
  openNoteIds,
  overlappingNoteIds,
  suggestedNotes,
  type NoteFilterKey,
} from "./note-panel-ui";

export interface NotePanelProps {
  readonly bookId: string;
  readonly chapterNum: number;
  readonly onLocate?: (note: ChapterNote) => void;
  readonly onApplied?: (result: NoteReviseApplyResponse) => void;
  readonly highlightNoteId?: string | null;
  readonly className?: string;
}

interface PanelToast {
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void | Promise<void>;
}

export function NotePanel({
  bookId,
  chapterNum,
  onLocate,
  onApplied,
  highlightNoteId = null,
  className,
}: NotePanelProps) {
  const [notes, setNotes] = useState<ChapterNote[]>([]);
  const [chapterHash, setChapterHash] = useState("");
  const [filter, setFilter] = useState<NoteFilterKey>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<PanelToast | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const task = useLongTask({ charCount: 0 });

  const reload = useCallback(async () => {
    const data = await listAnnotations(bookId, chapterNum);
    setNotes([...data.notes]);
    setChapterHash(data.chapterHash);
    setSelectedIds(new Set());
  }, [bookId, chapterNum]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listAnnotations(bookId, chapterNum)
      .then((data) => {
        if (cancelled) return;
        setNotes([...data.notes]);
        setChapterHash(data.chapterHash);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, chapterNum]);

  useEffect(() => {
    if (!highlightNoteId) return;
    document.getElementById(`note-${highlightNoteId}`)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [highlightNoteId]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const showToast = useCallback((next: PanelToast, ttlMs = 5000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(next);
    toastTimerRef.current = setTimeout(() => setToast(null), ttlMs);
  }, []);

  const counts = useMemo(() => countNotesByFilter(notes), [notes]);
  const visible = useMemo(() => filterNotes(notes, filter), [notes, filter]);
  const reviewMode = isReviewMode(notes);
  const openIds = useMemo(() => openNoteIds(notes), [notes]);
  const overlappingIds = useMemo(() => overlappingNoteIds(suggestedNotes(notes)), [notes]);
  const overlappingSet = useMemo(() => new Set(overlappingIds), [overlappingIds]);
  const canAcceptAll = canAcceptAllNotes(notes);
  const canAcceptSelected = canAcceptSelectedNotes(notes, selectedIds);
  const busy = loading || applying || task.running;

  const toggleSelect = useCallback((note: ChapterNote, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(note.id);
      else next.delete(note.id);
      return next;
    });
  }, []);

  const applyIds = useCallback(async (ids: string[]) => {
    if (ids.length === 0 || !chapterHash || busyRef.current) return;
    busyRef.current = true;
    setApplying(true);
    setError(null);
    try {
      const result = await applyNoteRevise(bookId, chapterNum, {
        acceptIds: ids,
        baseHash: chapterHash,
      });
      showToast({ message: APPLY_SUCCESS_TOAST });
      onApplied?.(result);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      busyRef.current = false;
      setApplying(false);
    }
  }, [bookId, chapterHash, chapterNum, onApplied, reload, showToast]);

  const handleRevise = useCallback(async () => {
    if (openIds.length === 0 || !chapterHash || busyRef.current || task.running) return;
    busyRef.current = true;
    setError(null);
    try {
      const result = await task.run(async ({ taskId, signal }) =>
        noteRevise(
          bookId,
          chapterNum,
          { baseHash: chapterHash, noteIds: openIds, taskId },
          { signal },
        ),
      );
      if (!result) {
        showToast({ message: CANCELLED_TOAST });
        return;
      }
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      busyRef.current = false;
    }
  }, [bookId, chapterHash, chapterNum, openIds, reload, showToast, task]);

  const handleDelete = useCallback(async (note: ChapterNote) => {
    if (busyRef.current) return;
    try {
      await deleteAnnotation(bookId, chapterNum, note.id);
      setNotes((current) => current.filter((item) => item.id !== note.id));
      showToast({
        message: DELETE_TOAST,
        actionLabel: UNDO_LABEL,
        onAction: async () => {
          const restored = await createAnnotation(bookId, chapterNum, {
            comment: note.comment,
            start: note.selector.start,
            end: note.selector.end,
            origin: note.origin,
          });
          setNotes((current) => [...current, restored.note]);
          setToast(null);
        },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [bookId, chapterNum, showToast]);

  const handleEdit = useCallback(async (note: ChapterNote, comment: string) => {
    const { note: updated } = await updateAnnotation(bookId, chapterNum, note.id, { comment });
    setNotes((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }, [bookId, chapterNum]);

  const handleReject = useCallback(async (note: ChapterNote) => {
    const { note: updated } = await updateAnnotation(bookId, chapterNum, note.id, { status: "rejected" });
    setNotes((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    setSelectedIds((current) => {
      if (!current.has(note.id)) return current;
      const next = new Set(current);
      next.delete(note.id);
      return next;
    });
  }, [bookId, chapterNum]);

  const handleRejectAll = useCallback(async () => {
    const targets = suggestedNotes(notes);
    for (const note of targets) {
      await handleReject(note);
    }
  }, [handleReject, notes]);

  return (
    <section
      className={cn("flex h-full min-h-0 flex-col gap-3", className)}
      data-testid="note-panel"
      aria-label="备注"
    >
      <NoteFilterBar filter={filter} counts={counts} disabled={busy} onChange={setFilter} />

      <BatchActionBar
        reviewMode={reviewMode}
        openCount={openIds.length}
        selectedCount={selectedIds.size}
        canAcceptAll={canAcceptAll}
        canAcceptSelected={canAcceptSelected}
        overlapping={overlappingIds.length > 0}
        disabled={busy || !chapterHash}
        onRevise={() => void handleRevise()}
        onAcceptSelected={() => void applyIds([...selectedIds])}
        onAcceptAll={() => void applyIds(suggestedNotes(notes).map((note) => note.id))}
        onRejectAll={() => void handleRejectAll()}
      />

      {task.running ? (
        <TaskProgressBanner
          kind="note_revise"
          estimateMs={task.estimateMs || NOTE_REVISE_DEFAULT_MS}
          elapsedSeconds={Math.floor(task.elapsedMs / 1000)}
          running={task.running}
          onCancel={task.cancel}
        />
      ) : null}

      {error ? (
        <p className="text-xs text-rose-700" role="alert">{error}</p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-zinc-400">
            <Spinner className="size-5" />
          </div>
        ) : visible.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-zinc-400">暂无备注</p>
        ) : (
          visible.map((note) =>
            note.status === "suggested" ? (
              <DiffReviewCard
                key={note.id}
                note={note}
                overlapping={overlappingSet.has(note.id)}
                selected={selectedIds.has(note.id)}
                highlighted={highlightNoteId === note.id}
                disabled={busy}
                onToggleSelect={toggleSelect}
                onAccept={(item) => void applyIds([item.id])}
                onReject={(item) => void handleReject(item)}
                onLocate={onLocate}
              />
            ) : (
              <NoteCard
                key={note.id}
                note={note}
                highlighted={highlightNoteId === note.id}
                disabled={busy}
                onLocate={onLocate}
                onDelete={(item) => void handleDelete(item)}
                onEdit={(item, comment) => handleEdit(item, comment)}
              />
            ),
          )
        )}
      </div>

      {toast ? (
        <div
          className="flex items-center justify-between gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-white"
          data-testid="note-panel-toast"
          role="status"
        >
          <span>{toast.message}</span>
          {toast.onAction && toast.actionLabel ? (
            <button
              type="button"
              className={cn(TAP_TARGET_CLASS, "h-11 rounded-md px-2 font-medium text-amber-200 md:h-8")}
              onClick={() => void toast.onAction?.()}
            >
              {toast.actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function NoteFilterBar({
  filter,
  counts,
  disabled,
  onChange,
}: {
  readonly filter: NoteFilterKey;
  readonly counts: Record<NoteFilterKey, number>;
  readonly disabled: boolean;
  readonly onChange: (key: NoteFilterKey) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="note-filter-bar">
      {NOTE_FILTER_KEYS.map((key) => {
        const active = filter === key;
        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            className={cn(
              TAP_TARGET_CLASS,
              "rounded-full border px-3 text-xs font-medium transition-colors",
              active
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300",
            )}
            onClick={() => onChange(key)}
          >
            {filterButtonLabel(key, counts[key])}
          </button>
        );
      })}
    </div>
  );
}

function BatchActionBar({
  reviewMode,
  openCount,
  selectedCount,
  canAcceptAll,
  canAcceptSelected,
  overlapping,
  disabled,
  onRevise,
  onAcceptSelected,
  onAcceptAll,
  onRejectAll,
}: {
  readonly reviewMode: boolean;
  readonly openCount: number;
  readonly selectedCount: number;
  readonly canAcceptAll: boolean;
  readonly canAcceptSelected: boolean;
  readonly overlapping: boolean;
  readonly disabled: boolean;
  readonly onRevise: () => void;
  readonly onAcceptSelected: () => void;
  readonly onAcceptAll: () => void;
  readonly onRejectAll: () => void;
}) {
  if (reviewMode) {
    return (
      <div className="space-y-2" data-testid="batch-action-bar">
        {overlapping ? (
          <p className="text-xs text-rose-600">
            存在{OVERLAP_LABEL}，已禁用「全部通过」，请逐条审阅。
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={disabled || !canAcceptSelected}
            className={cn(TAP_TARGET_CLASS, "h-11 md:h-8")}
            onClick={onAcceptSelected}
          >
            {acceptSelectedLabel(selectedCount)}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={disabled || !canAcceptAll}
            className={cn(TAP_TARGET_CLASS, "h-11 md:h-8")}
            onClick={onAcceptAll}
          >
            全部通过
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={disabled}
            className={cn(TAP_TARGET_CLASS, "h-11 md:h-8")}
            onClick={onRejectAll}
          >
            全部拒绝
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="batch-action-bar">
      <Button
        type="button"
        disabled={disabled || openCount === 0}
        className={cn(TAP_TARGET_CLASS, "h-11 w-full md:h-9")}
        onClick={onRevise}
      >
        {batchReviseLabel(openCount)}
      </Button>
    </div>
  );
}
