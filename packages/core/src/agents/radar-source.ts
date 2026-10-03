export interface RankingEntry {
  readonly title: string;
  readonly author: string;
  readonly category: string;
  readonly extra: string;
}

export interface PlatformRankings {
  readonly platform: string;
  readonly entries: ReadonlyArray<RankingEntry>;
}

/**
 * Pluggable data source for the Radar agent.
 * Implement this interface to feed custom ranking/trend data
 * (e.g. from OpenClaw, custom scrapers, paid APIs).
 */
export interface RadarSource {
  readonly name: string;
  fetch(): Promise<PlatformRankings>;
}

/**
 * Wraps raw natural language text as a radar source.
 * Use this to inject external analysis (e.g. from OpenClaw) into the radar pipeline.
 */
export class TextRadarSource implements RadarSource {
  readonly name: string;
  private readonly text: string;

  constructor(text: string, name = "external") {
    this.name = name;
    this.text = text;
  }

  async fetch(): Promise<PlatformRankings> {
    return {
      platform: this.name,
      entries: [{ title: this.text, author: "", category: "", extra: "[外部分析]" }],
    };
  }
}

// ---------------------------------------------------------------------------
// Built-in sources
// ---------------------------------------------------------------------------

/** Per-request timeout for built-in radar sources. */
export const RADAR_FETCH_TIMEOUT_MS = 20_000;

function radarTimeoutSignal(): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(RADAR_FETCH_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

// Fanqie rank_list v2: `type=1` is the male channel, `type=0` the female
// channel (the API default when `type` is omitted). The lists mix in short
// dramas (genre 205), which are not novels and must be skipped.
const FANQIE_RANK_TYPES = [
  { sideType: 10, type: 1, label: "男频热门榜" },
  { sideType: 13, type: 1, label: "男频黑马榜" },
  { sideType: 10, type: 0, label: "女频热门榜" },
  { sideType: 13, type: 0, label: "女频黑马榜" },
] as const;

const FANQIE_SHORT_DRAMA_GENRE = "205";
export const FANQIE_PER_LIST = 20;
// The API currently returns up to 30 items regardless of `limit`; ask for 30 so
// there is still a full list after short dramas are filtered out.
const FANQIE_REQUEST_LIMIT = 30;

export function buildFanqieRankUrl(sideType: number, type: number): string {
  return `https://api-lf.fanqiesdk.com/api/novel/channel/homepage/rank/rank_list/v2/?aid=13&limit=${FANQIE_REQUEST_LIMIT}&offset=0&side_type=${sideType}&type=${type}`;
}

/** Parse one Fanqie rank_list v2 response into ranking entries. */
export function parseFanqieRankList(
  data: unknown,
  label: string,
  limit = FANQIE_PER_LIST,
): RankingEntry[] {
  const list = (data as { data?: { result?: unknown[] } } | null)?.data?.result;
  if (!Array.isArray(list)) return [];
  const entries: RankingEntry[] = [];
  for (const item of list) {
    const rec = (item ?? {}) as Record<string, unknown>;
    if (String(rec.genre ?? "") === FANQIE_SHORT_DRAMA_GENRE) continue;
    const title = String(rec.book_name ?? "").trim();
    if (!title) continue;
    entries.push({
      title,
      author: String(rec.author ?? ""),
      category: String(rec.category ?? ""),
      extra: `[${label}]`,
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

export class FanqieRadarSource implements RadarSource {
  readonly name = "fanqie";

  async fetch(): Promise<PlatformRankings> {
    const entries: RankingEntry[] = [];

    for (const { sideType, type, label } of FANQIE_RANK_TYPES) {
      try {
        const res = await globalThis.fetch(buildFanqieRankUrl(sideType, type), {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; InkOS/0.1)" },
          signal: radarTimeoutSignal(),
        });
        if (!res.ok) continue;
        entries.push(...parseFanqieRankList(await res.json(), label));
      } catch {
        // skip on network error / timeout
      }
    }

    return { platform: "番茄小说", entries };
  }
}

// Qidian: www.qidian.com/rank/ now sits behind a JS anti-bot challenge
// (HTTP 202 + probe.js), so read the mobile rank pages instead. They are
// server-rendered and embed the list as JSON in the vite-plugin-ssr pageContext.
const QIDIAN_MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const QIDIAN_RANK_LISTS = [
  { path: "yuepiao", label: "起点月票榜" },
  { path: "hotsales", label: "起点畅销榜" },
  { path: "readindex", label: "起点阅读指数榜" },
  { path: "newbook", label: "起点新书榜" },
] as const;

export const QIDIAN_PER_LIST = 20;

interface QidianRankRecord {
  readonly bName?: unknown;
  readonly bAuth?: unknown;
  readonly cat?: unknown;
  readonly subCat?: unknown;
  readonly rankCnt?: unknown;
}

function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function extractQidianRecords(html: string): QidianRankRecord[] {
  const script = html.match(
    /<script[^>]*id="vite-plugin-ssr_pageContext"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (script) {
    try {
      const ctx = JSON.parse(script[1]) as {
        pageContext?: { pageProps?: { pageData?: { records?: unknown } } };
      };
      const records = ctx.pageContext?.pageProps?.pageData?.records;
      if (Array.isArray(records)) return records as QidianRankRecord[];
    } catch {
      // fall through to the regex fallback
    }
  }

  // Fallback: scrape bName/bAuth/cat pairs from the raw JSON text.
  const out: QidianRankRecord[] = [];
  const pattern = /"bName":"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const tail = html.slice(match.index, match.index + 600);
    const field = (name: string): string | undefined => {
      const m = tail.match(new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`));
      return m ? decodeJsonString(m[1]) : undefined;
    };
    out.push({
      bName: decodeJsonString(match[1]),
      bAuth: field("bAuth") ?? "",
      cat: field("cat"),
      subCat: field("subCat"),
      rankCnt: field("rankCnt"),
    });
  }
  return out;
}

/** Parse one m.qidian.com rank page into ranking entries. */
export function parseQidianRankHtml(
  html: string,
  label: string,
  limit = QIDIAN_PER_LIST,
): RankingEntry[] {
  const entries: RankingEntry[] = [];
  const seen = new Set<string>();
  for (const rec of extractQidianRecords(html)) {
    const title = String(rec.bName ?? "").trim();
    if (!title || title.length < 2 || title.length > 40 || seen.has(title)) continue;
    seen.add(title);
    const category = [rec.cat, rec.subCat]
      .filter((value) => value !== undefined && value !== null && String(value).trim() !== "")
      .map(String)
      .join("·");
    const metric = rec.rankCnt ? ` ${String(rec.rankCnt)}` : "";
    entries.push({
      title,
      author: String(rec.bAuth ?? ""),
      category,
      extra: `[${label}]${metric}`,
    });
    if (entries.length >= limit) break;
  }
  return entries;
}

export class QidianRadarSource implements RadarSource {
  readonly name = "qidian";

  async fetch(): Promise<PlatformRankings> {
    const entries: RankingEntry[] = [];

    for (const { path, label } of QIDIAN_RANK_LISTS) {
      try {
        const res = await globalThis.fetch(`https://m.qidian.com/rank/${path}/`, {
          headers: {
            "User-Agent": QIDIAN_MOBILE_UA,
            Accept: "text/html,application/xhtml+xml",
            "Accept-Language": "zh-CN,zh;q=0.9",
          },
          signal: radarTimeoutSignal(),
        });
        // 202 means the anti-bot challenge page, not the list.
        if (res.status !== 200) continue;
        entries.push(...parseQidianRankHtml(await res.text(), label));
      } catch {
        // skip on network error / timeout
      }
    }

    return { platform: "起点中文网", entries };
  }
}
