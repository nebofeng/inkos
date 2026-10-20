import { cn } from "@/lib/utils";
import { TAP_TARGET_CLASS } from "./note-panel-ui";
import { railNotesLabel, type RailTab } from "../../pages/chapter-reader-notes";

export interface RailTabHeaderProps {
  readonly active: RailTab;
  readonly noteCount: number;
  readonly onChange: (tab: RailTab) => void;
}

export function RailTabHeader({ active, noteCount, onChange }: RailTabHeaderProps) {
  return (
    <div
      role="tablist"
      aria-label="右栏"
      data-testid="rail-tab-header"
      className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1"
    >
      <TabButton
        id="rail-tab-chat"
        active={active === "chat"}
        onClick={() => onChange("chat")}
      >
        对话
      </TabButton>
      <TabButton
        id="rail-tab-notes"
        active={active === "notes"}
        onClick={() => onChange("notes")}
      >
        {railNotesLabel(noteCount)}
      </TabButton>
    </div>
  );
}

function TabButton({
  id,
  active,
  onClick,
  children,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      data-testid={id}
      className={cn(
        TAP_TARGET_CLASS,
        "rounded-md px-2 text-xs font-medium transition-colors",
        active ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
