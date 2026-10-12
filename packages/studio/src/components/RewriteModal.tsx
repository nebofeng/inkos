import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export const REWRITE_PRESETS = [
  { id: "pace", zh: "加快节奏", en: "Faster pacing" },
  { id: "describe", zh: "增加描写", en: "More description" },
  { id: "inner", zh: "心理活动", en: "Inner thoughts" },
  { id: "dialogue", zh: "加强对白", en: "Stronger dialogue" },
  { id: "conflict", zh: "强化冲突", en: "Sharper conflict" },
] as const;

export function countRewriteChars(text: string): number {
  return [...text].length;
}

export function composeRewriteBrief(
  text: string,
  presetLabels: ReadonlyArray<string>,
): string {
  const trimmed = text.trim();
  const tags = presetLabels.map((label) => label.trim()).filter(Boolean);
  if (tags.length === 0) return trimmed;
  const tagLine = tags.join(" / ");
  return trimmed ? `${tagLine}\n${trimmed}` : tagLine;
}

export function RewriteModal({
  open,
  language = "zh",
  busy = false,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly language?: "zh" | "en" | string;
  readonly busy?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (brief: string) => void;
}) {
  const isEn = language === "en";
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);

  const chars = countRewriteChars(text);
  const selectedLabels = useMemo(
    () => REWRITE_PRESETS.filter((preset) => selected.includes(preset.id)).map((preset) => (isEn ? preset.en : preset.zh)),
    [isEn, selected],
  );

  const togglePreset = (id: string) => {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const close = () => {
    if (busy) return;
    onOpenChange(false);
  };

  const confirm = () => {
    onConfirm(composeRewriteBrief(text, selectedLabels));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (busy) return;
          setText("");
          setSelected([]);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg p-5 gap-4" data-testid="rewrite-modal">
        <DialogHeader>
          <DialogTitle>{isEn ? "Rewrite this chapter" : "重写本章"}</DialogTitle>
          <DialogDescription>
            {isEn
              ? "Optional brief for this run. Leave blank to keep the existing focus."
              : "可选：输入这次重写要遵循的补充想法。留空则沿用现有 focus。"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          {REWRITE_PRESETS.map((preset) => {
            const active = selected.includes(preset.id);
            return (
              <button
                key={preset.id}
                type="button"
                data-testid={`rewrite-preset-${preset.id}`}
                onClick={() => togglePreset(preset.id)}
                className={`min-h-11 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {isEn ? preset.en : preset.zh}
              </button>
            );
          })}
        </div>

        <textarea
          data-testid="rewrite-brief"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          className="w-full resize-y rounded-lg border border-border/70 bg-background px-3 py-3 text-sm leading-6 outline-none focus:border-primary/50"
          placeholder={isEn ? "What should this rewrite keep, cut, or intensify?" : "这次重写要保留什么、砍掉什么、加强什么？"}
        />

        <div className="text-xs text-muted-foreground tabular-nums" data-testid="rewrite-char-count">
          {chars} {isEn ? "characters" : "字"}
        </div>

        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="min-h-11 rounded-md px-3 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {isEn ? "Cancel" : "取消"}
          </button>
          <button
            type="button"
            data-testid="rewrite-confirm"
            onClick={confirm}
            disabled={busy}
            className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? (isEn ? "Rewriting…" : "重写中…") : (isEn ? "Rewrite" : "确认重写")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
