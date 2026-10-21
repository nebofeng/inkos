// Opposition / antagonist ladder — display-only parse of outline/antagonist_arc.md
// (YAML frontmatter list or markdown table). Never invents rungs; empty/broken
// input yields []. Callers hide or collapse based on ladderPresence().

export const ANTAGONIST_ARC_FILE = "outline/antagonist_arc.md";
export const VOLUME_MAP_FILE = "outline/volume_map.md";

export const MOBILE_LADDER_PREVIEW = 2;
export const MOBILE_LADDER_COLLAPSE_THRESHOLD = 3;

export interface OppositionRung {
  readonly volume: string;
  readonly volumeNumber: number | null;
  readonly opponent: string;
  readonly crisis: string;
  readonly countermove: string;
  readonly finale: boolean;
}

export type LadderPresence = "missing" | "empty" | "ready";

export function parseOppositionLadder(raw: string | null | undefined): ReadonlyArray<OppositionRung> {
  if (!raw || !raw.trim()) return [];
  try {
    const fm = extractFrontmatterBlock(raw);
    if (fm) {
      const fromYaml = parseYamlLadderList(fm);
      if (fromYaml.length > 0) return fromYaml;
    }
    return parseMarkdownLadderTable(stripFrontmatter(raw));
  } catch {
    return [];
  }
}

export function ladderPresence(input: {
  readonly fileFound: boolean;
  readonly volumeMapFound: boolean;
  readonly rungs: ReadonlyArray<OppositionRung>;
}): LadderPresence {
  if (input.rungs.length > 0) return "ready";
  if (input.fileFound || input.volumeMapFound) return "empty";
  return "missing";
}

export function previewLadderRungs(
  rungs: ReadonlyArray<OppositionRung>,
  opts: { readonly mobile: boolean; readonly expanded: boolean },
): ReadonlyArray<OppositionRung> {
  if (!opts.mobile || opts.expanded || rungs.length <= MOBILE_LADDER_COLLAPSE_THRESHOLD) {
    return rungs;
  }
  return rungs.slice(0, MOBILE_LADDER_PREVIEW);
}

export function collapsedRungCount(
  rungs: ReadonlyArray<OppositionRung>,
  opts: { readonly mobile: boolean; readonly expanded: boolean },
): number {
  return Math.max(0, rungs.length - previewLadderRungs(rungs, opts).length);
}

export function formatVolumeLabel(volume: string | number | null | undefined, lang: "zh" | "en" = "zh"): string {
  if (volume === null || volume === undefined) return "";
  const raw = String(volume).trim();
  if (!raw) return "";
  if (/终局|finale|规则重构/i.test(raw)) return lang === "en" ? "Finale" : "终局";
  const n = parseVolumeNumber(raw);
  if (n !== null) return lang === "en" ? `Vol. ${n}` : `第${n}卷`;
  return raw;
}

function extractFrontmatterBlock(raw: string): string | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  return m ? m[1] : null;
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
}

const LIST_KEY = /^(opposition_ladder|antagonist_arc)\s*:\s*$/i;

function parseYamlLadderList(fm: string): OppositionRung[] {
  const lines = fm.split(/\r?\n/);
  let inList = false;
  const items: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;

  for (const line of lines) {
    if (!inList) {
      if (LIST_KEY.test(line.trim())) inList = true;
      continue;
    }
    if (/^\S/.test(line) && !line.trim().startsWith("-") && !LIST_KEY.test(line.trim())) {
      break;
    }
    const trimmed = line.trimEnd();
    const itemStart = trimmed.match(/^(\s*)-\s+(.*)$/);
    if (itemStart) {
      current = {};
      items.push(current);
      const rest = itemStart[2].trim();
      const inline = rest.match(/^([^:]+):\s*(.*)$/);
      if (inline) current[normalizeKey(inline[1])] = unquote(inline[2]);
      continue;
    }
    const field = trimmed.match(/^\s+([^:]+):\s*(.*)$/);
    if (field && current) {
      current[normalizeKey(field[1])] = unquote(field[2]);
    }
  }

  return items.map(recordToRung).filter((r): r is OppositionRung => r !== null);
}

function parseMarkdownLadderTable(md: string): OppositionRung[] {
  const rows = md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));
  if (rows.length < 2) return [];
  const header = splitTableRow(rows[0]);
  const colOf = (...names: string[]) =>
    header.findIndex((h) => names.some((n) => h.replace(/\s+/g, "").toLowerCase() === n.toLowerCase()));

  const volumeIdx = colOf("卷次", "卷", "vol", "vol.", "volume");
  const opponentIdx = colOf("对立面", "对手", "谁", "opponent", "who");
  const crisisIdx = colOf("面临危机", "危机", "问题", "crisis", "problem");
  const moveIdx = colOf("破局解法", "破局", "怎么赢", "countermove", "win");
  const kindIdx = colOf("类型", "kind", "终局", "finale");

  if (opponentIdx < 0 && crisisIdx < 0) return [];

  return rows
    .slice(1)
    .filter((line) => !/^\|\s*-{2,}/.test(line))
    .map(splitTableRow)
    .map((cells) =>
      recordToRung({
        volume: volumeIdx >= 0 ? cells[volumeIdx] ?? "" : "",
        opponent: opponentIdx >= 0 ? cells[opponentIdx] ?? "" : "",
        crisis: crisisIdx >= 0 ? cells[crisisIdx] ?? "" : "",
        countermove: moveIdx >= 0 ? cells[moveIdx] ?? "" : "",
        kind: kindIdx >= 0 ? cells[kindIdx] ?? "" : "",
      }),
    )
    .filter((r): r is OppositionRung => r !== null);
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function recordToRung(rec: Record<string, string>): OppositionRung | null {
  const opponent = pick(rec, "opponent", "who", "antagonist", "对立面", "对手", "谁");
  const crisis = pick(rec, "crisis", "problem", "面临危机", "危机", "问题");
  const countermove = pick(rec, "countermove", "win", "破局解法", "破局", "怎么赢");
  if (!opponent) return null;
  if (!crisis && !countermove) return null;

  const volumeRaw = pick(rec, "volume", "vol", "卷次", "卷");
  const kind = pick(rec, "kind", "类型", "finale", "终局");
  const finaleFlag = pick(rec, "finale");
  const finale = isFinaleMarker(kind) || isFinaleMarker(finaleFlag) || isFinaleMarker(volumeRaw) || isFinaleMarker(opponent);

  return {
    volume: volumeRaw,
    volumeNumber: parseVolumeNumber(volumeRaw),
    opponent,
    crisis,
    countermove,
    finale,
  };
}

function pick(rec: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const v = rec[normalizeKey(key)];
    if (v?.trim()) return v.trim();
  }
  return "";
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function unquote(value: string): string {
  const v = value.trim();
  const m = v.match(/^["']([\s\S]*)["']$/);
  return (m ? m[1] : v).trim();
}

function parseVolumeNumber(raw: string): number | null {
  const m = String(raw).match(/(\d+)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function isFinaleMarker(value: string): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return /^(true|yes|y|终局|finale|rule_rewrite|rule-rewrite|规则重构)$/i.test(v)
    || /规则重构|rule\s*rewrite/i.test(v);
}
