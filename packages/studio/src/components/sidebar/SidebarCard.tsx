import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

interface SidebarCardProps {
  readonly title: string;
  readonly defaultOpen?: boolean;
  readonly children: React.ReactNode;
  readonly actions?: React.ReactNode;
}

export function SidebarCard({ title, defaultOpen = true, children, actions }: SidebarCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl bg-card/60">
      <div className="flex w-full items-center justify-between px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="text-base font-medium text-foreground font-['SimSun','Songti_SC','STSong',serif]">{title}</span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={title}
            className="flex h-7 w-7 items-center justify-center"
          >
            <ChevronDown className={cn("w-[18px] h-[18px] text-muted-foreground transition-transform", open && "rotate-180")} />
          </button>
        </div>
      </div>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}
