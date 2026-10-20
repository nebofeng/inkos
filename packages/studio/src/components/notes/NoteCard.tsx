import { useState } from "react";
import { MapPin, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ChapterNote } from "@/lib/annotation-client";
import { noteStatusBadge } from "@/lib/note-panel-logic";
import {
  CARD_BASE_CLASS,
  TAP_TARGET_CLASS,
  quotePreview,
  statusBadgeClass,
} from "./note-panel-ui";

export interface NoteCardProps {
  readonly note: ChapterNote;
  readonly highlighted?: boolean;
  readonly disabled?: boolean;
  readonly onLocate?: (note: ChapterNote) => void;
  readonly onDelete?: (note: ChapterNote) => void;
  readonly onEdit?: (note: ChapterNote, comment: string) => void | Promise<void>;
}

export function NoteCard({
  note,
  highlighted = false,
  disabled = false,
  onLocate,
  onDelete,
  onEdit,
}: NoteCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.comment);
  const [saving, setSaving] = useState(false);
  const orphaned = note.status === "orphaned";

  const save = async () => {
    const next = draft.trim();
    if (!next || next === note.comment) {
      setEditing(false);
      setDraft(note.comment);
      return;
    }
    setSaving(true);
    try {
      await onEdit?.(note, next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article
      id={`note-${note.id}`}
      data-testid="note-card"
      data-note-id={note.id}
      data-status={note.status}
      className={cn(
        CARD_BASE_CLASS,
        orphaned && "opacity-70",
        highlighted && "ring-2 ring-indigo-400",
      )}
      onClick={() => onLocate?.(note)}
    >
      <div className="flex items-start justify-between gap-2">
        <Badge variant="outline" className={statusBadgeClass(note.status)}>
          {noteStatusBadge(note.status)}
        </Badge>
        {note.origin === "user" ? (
          <span className="text-[11px] text-zinc-400">我的建议</span>
        ) : (
          <span className="text-[11px] text-zinc-400">系统建议</span>
        )}
      </div>

      <blockquote className="mt-2 border-l-2 border-amber-300 pl-2 text-sm text-zinc-600">
        {quotePreview(note.selector.exact)}
      </blockquote>

      {editing ? (
        <div className="mt-2 space-y-2" onClick={(event) => event.stopPropagation()}>
          <Textarea
            value={draft}
            rows={3}
            disabled={saving || disabled}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-16 text-sm"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={saving || disabled || !draft.trim()}
              className={cn(TAP_TARGET_CLASS, "h-11 md:h-8")}
              onClick={() => void save()}
            >
              保存
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving}
              className={cn(TAP_TARGET_CLASS, "h-11 md:h-8")}
              onClick={() => {
                setEditing(false);
                setDraft(note.comment);
              }}
            >
              取消
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm text-zinc-800">{note.comment}</p>
      )}

      <div
        className="mt-3 flex flex-wrap gap-1.5"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || orphaned}
          className={cn(TAP_TARGET_CLASS, "h-11 gap-1 md:h-8")}
          onClick={() => onLocate?.(note)}
        >
          <MapPin className="size-3.5" />
          定位
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || editing || note.status === "accepted"}
          className={cn(TAP_TARGET_CLASS, "h-11 gap-1 md:h-8")}
          onClick={() => {
            setDraft(note.comment);
            setEditing(true);
          }}
        >
          <Pencil className="size-3.5" />
          编辑
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          className={cn(TAP_TARGET_CLASS, "h-11 gap-1 text-rose-700 md:h-8")}
          onClick={() => onDelete?.(note)}
        >
          <Trash2 className="size-3.5" />
          删除
        </Button>
      </div>
    </article>
  );
}
