import { LogOut } from "lucide-react";
import { useState } from "react";
import { useApi } from "../hooks/use-api";
import { tr } from "../lib/app-language";
import { logout } from "../lib/auth-client";

interface AuthSession {
  readonly authenticated: boolean;
  readonly authDisabled: boolean;
  readonly user: string | null;
}

/** Sidebar footer: agent status (when online) + logged-in user and a logout button. */
export function SidebarFooter({ agentOnline, agentOnlineLabel }: { readonly agentOnline: boolean; readonly agentOnlineLabel: string }) {
  const { data: session } = useApi<AuthSession>("/auth/session");
  const [leaving, setLeaving] = useState(false);
  const showLogout = Boolean(session?.authenticated && !session.authDisabled);
  if (!agentOnline && !showLogout) return null;

  return (
    <div className="p-4 border-t border-border bg-secondary/40 space-y-2">
      {agentOnline && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-card border border-border shadow-sm">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[11px] font-semibold text-foreground/80 uppercase tracking-wider">
            {agentOnlineLabel}
          </span>
        </div>
      )}
      {showLogout && (
        <button
          type="button"
          data-testid="studio-logout"
          disabled={leaving}
          onClick={() => {
            setLeaving(true);
            void logout();
          }}
          className="w-full flex min-h-11 items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors disabled:opacity-60"
        >
          <LogOut size={16} className="shrink-0" />
          <span className="flex-1 truncate text-left">{tr("退出登录", "Log out")}</span>
          {session?.user && <span className="max-w-[45%] truncate text-xs text-muted-foreground/70">{session.user}</span>}
        </button>
      )}
    </div>
  );
}
