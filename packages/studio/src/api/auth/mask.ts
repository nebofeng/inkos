/**
 * API-key masking for Studio responses. A masked value looks like
 * `****abcd` (only the last 4 characters of the real key). The UI shows it
 * as-is; when it is sent back unchanged (save / test / list models), the
 * server substitutes the stored key instead of overwriting it.
 */
export const MASK_PREFIX = "****";
const VISIBLE_TAIL = 4;

export function maskSecret(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "";
  // Very short values: do not reveal anything.
  if (value.length <= VISIBLE_TAIL * 2) return MASK_PREFIX;
  return `${MASK_PREFIX}${value.slice(-VISIBLE_TAIL)}`;
}

export function maskNullableSecret(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return maskSecret(value);
}

/** True when the value is a mask we produced (no real key starts with `****`). */
export function isMaskedSecret(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.startsWith(MASK_PREFIX) && trimmed.length <= MASK_PREFIX.length + VISIBLE_TAIL
    && !trimmed.slice(MASK_PREFIX.length).includes("*");
}

export type MaskedResolution =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "stored"; readonly value: string }
  | { readonly kind: "missing-stored" };

/**
 * Resolve an incoming key: a masked value means "keep / use the stored key".
 * `missing-stored` means the client sent a mask but nothing (or a different
 * key) is stored, so the caller must ask the user to re-enter the full key.
 */
export function resolveMaskedSecret(incoming: string | null | undefined, stored: string | null | undefined): MaskedResolution {
  const value = typeof incoming === "string" ? incoming.trim() : "";
  if (!isMaskedSecret(value)) return { kind: "value", value };
  const storedValue = typeof stored === "string" ? stored : "";
  if (storedValue && maskSecret(storedValue) === value) return { kind: "stored", value: storedValue };
  return { kind: "missing-stored" };
}
