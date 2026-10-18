import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";

export interface PromptDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly defaultValue?: string;
  readonly required?: boolean;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly placeholder?: string;
  readonly onConfirm: (value: string) => void;
  readonly onCancel: () => void;
}

export function PromptDialog({
  open,
  title,
  description,
  defaultValue = "",
  required = false,
  confirmLabel = "确认",
  cancelLabel = "取消",
  placeholder,
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const [text, setText] = useState(defaultValue);

  useEffect(() => {
    if (open) setText(defaultValue);
  }, [open, defaultValue]);

  const close = () => {
    setText(defaultValue);
    onCancel();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-lg p-5 gap-4" data-testid="prompt-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <Textarea
          data-testid="prompt-dialog-input"
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          placeholder={placeholder}
          className="w-full resize-y rounded-lg border border-border/70 bg-background px-3 py-3 text-sm leading-6"
        />
        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={close}
            className="min-h-11 rounded-md px-3 text-sm text-muted-foreground hover:text-foreground"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid="prompt-dialog-confirm"
            disabled={required && !text.trim()}
            onClick={() => {
              if (required && !text.trim()) return;
              onConfirm(text);
            }}
            className="min-h-11 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface PromptTextOptions {
  readonly title: string;
  readonly description?: string;
  readonly defaultValue?: string;
  readonly required?: boolean;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly placeholder?: string;
}

interface PromptRequest extends PromptTextOptions {
  readonly resolve: (value: string | null) => void;
}

export function usePromptDialog(): {
  readonly promptText: (options: PromptTextOptions) => Promise<string | null>;
  readonly promptDialog: ReactNode;
} {
  const [request, setRequest] = useState<PromptRequest | null>(null);
  const settledRef = useRef(false);

  const promptText = useCallback((options: PromptTextOptions) => {
    settledRef.current = false;
    return new Promise<string | null>((resolve) => {
      setRequest({ ...options, resolve });
    });
  }, []);

  const close = (value: string | null) => {
    if (settledRef.current) return;
    settledRef.current = true;
    request?.resolve(value);
    setRequest(null);
  };

  const promptDialog = (
    <PromptDialog
      open={request !== null}
      title={request?.title ?? ""}
      description={request?.description}
      defaultValue={request?.defaultValue ?? ""}
      required={request?.required}
      confirmLabel={request?.confirmLabel}
      cancelLabel={request?.cancelLabel}
      placeholder={request?.placeholder}
      onConfirm={(value) => close(value)}
      onCancel={() => close(null)}
    />
  );

  return { promptText, promptDialog };
}
