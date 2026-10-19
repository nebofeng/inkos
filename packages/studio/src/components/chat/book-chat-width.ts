export const BOOK_CHAT_WIDTH_KEY = "inkos:studio:book-chat-width";
export const CHAT_MIN = 300;
export const CHAT_MAX = 480;
export const CHAT_DEFAULT = 320;
export const CHAT_WIDE_DEFAULT = 360;
export const CHAT_WIDE_BREAKPOINT = 1440;

export function getChatDefaultWidth(viewportWidth: number): number {
  return viewportWidth >= CHAT_WIDE_BREAKPOINT ? CHAT_WIDE_DEFAULT : CHAT_DEFAULT;
}

export function clampChatWidth(width: number): number {
  if (!Number.isFinite(width)) return CHAT_DEFAULT;
  return Math.min(CHAT_MAX, Math.max(CHAT_MIN, Math.round(width)));
}

export function parseStoredChatWidth(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < CHAT_MIN || value > CHAT_MAX) return null;
  return Math.round(value);
}

export function readChatWidth(
  storage: Pick<Storage, "getItem"> | null | undefined,
  viewportWidth: number,
): number {
  try {
    const stored = parseStoredChatWidth(storage?.getItem(BOOK_CHAT_WIDTH_KEY) ?? null);
    if (stored != null) return stored;
  } catch {
    // Ignore storage failures and fall back to the viewport default.
  }
  return getChatDefaultWidth(viewportWidth);
}

export function writeChatWidth(storage: Pick<Storage, "setItem"> | null | undefined, width: number): void {
  try {
    storage?.setItem(BOOK_CHAT_WIDTH_KEY, String(clampChatWidth(width)));
  } catch {
    // Ignore quota / private-mode failures.
  }
}
