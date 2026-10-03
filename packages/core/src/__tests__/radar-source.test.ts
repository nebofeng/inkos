import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FanqieRadarSource,
  QidianRadarSource,
  buildFanqieRankUrl,
  parseFanqieRankList,
  parseQidianRankHtml,
} from "../agents/radar-source.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/radar/${name}`, import.meta.url), "utf-8");

const qidianHtml = fixture("qidian-m-rank-yuepiao.html");
const fanqieMaleHot = JSON.parse(fixture("fanqie-rank-male-hot.json")) as unknown;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseQidianRankHtml", () => {
  it("reads title, author and category from the SSR pageContext JSON", () => {
    const entries = parseQidianRankHtml(qidianHtml, "起点月票榜");
    expect(entries).toHaveLength(20);
    expect(entries[0]).toEqual({
      title: "玄鉴仙族",
      author: "季越人",
      category: "仙侠·修真文明",
      extra: "[起点月票榜] 4.4万月票",
    });
    expect(entries.every((entry) => entry.author.length > 0)).toBe(true);
    expect(new Set(entries.map((entry) => entry.title)).size).toBe(entries.length);
  });

  it("falls back to regex scraping when the pageContext JSON is unusable", () => {
    const broken = qidianHtml.replace('{"pageContext"', '{"pageContext" BROKEN');
    const entries = parseQidianRankHtml(broken, "起点月票榜");
    expect(entries).toHaveLength(20);
    expect(entries[0]).toMatchObject({ title: "玄鉴仙族", author: "季越人", category: "仙侠·修真文明" });
  });

  it("decodes escaped characters in the regex fallback", () => {
    const html = '<script>var x={"bName":"\\u4e66\\"名","bAuth":"作者A","cat":"玄幻"}</script>';
    expect(parseQidianRankHtml(html, "榜")).toEqual([
      { title: '书"名', author: "作者A", category: "玄幻", extra: "[榜]" },
    ]);
  });

  it("returns nothing for the anti-bot challenge page", () => {
    expect(parseQidianRankHtml("<html><script src=\"probe.js\"></script></html>", "榜")).toEqual([]);
  });
});

describe("parseFanqieRankList", () => {
  it("drops short dramas (genre 205) and caps at 20 entries", () => {
    const raw = (fanqieMaleHot as { data: { result: Array<{ genre: unknown }> } }).data.result;
    expect(raw.some((item) => String(item.genre) === "205")).toBe(true);
    const entries = parseFanqieRankList(fanqieMaleHot, "男频热门榜");
    expect(entries).toHaveLength(20);
    expect(entries.every((entry) => entry.extra === "[男频热门榜]" && entry.title.length > 0)).toBe(true);
  });

  it("tolerates malformed payloads", () => {
    expect(parseFanqieRankList(null, "x")).toEqual([]);
    expect(parseFanqieRankList({ data: {} }, "x")).toEqual([]);
  });
});

describe("built-in radar sources", () => {
  it("FanqieRadarSource queries male and female hot/dark-horse lists with a timeout", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect(init?.signal).toBeDefined();
      return new Response(JSON.stringify(fanqieMaleHot), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new FanqieRadarSource().fetch();
    expect(result.platform).toBe("番茄小说");
    expect(urls).toEqual([
      buildFanqieRankUrl(10, 1),
      buildFanqieRankUrl(13, 1),
      buildFanqieRankUrl(10, 0),
      buildFanqieRankUrl(13, 0),
    ]);
    expect(urls.every((url) => /[?&]type=[01]$/.test(url))).toBe(true);
    const labels = new Set(result.entries.map((entry) => entry.extra));
    expect(labels).toEqual(new Set(["[男频热门榜]", "[男频黑马榜]", "[女频热门榜]", "[女频黑马榜]"]));
    expect(result.entries).toHaveLength(80);
  });

  it("FanqieRadarSource keeps going when one list fails", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("timeout");
      if (call === 2) return new Response("bad", { status: 500 });
      return new Response(JSON.stringify(fanqieMaleHot), { status: 200 });
    }));
    const result = await new FanqieRadarSource().fetch();
    expect(result.entries).toHaveLength(40);
  });

  it("QidianRadarSource reads the four mobile rank pages with an iPhone UA", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["User-Agent"]).toContain("iPhone");
      expect(init?.signal).toBeDefined();
      if (url.includes("newbook")) return new Response("challenge", { status: 202 });
      return new Response(qidianHtml, { status: 200 });
    }));

    const result = await new QidianRadarSource().fetch();
    expect(result.platform).toBe("起点中文网");
    expect(urls).toEqual([
      "https://m.qidian.com/rank/yuepiao/",
      "https://m.qidian.com/rank/hotsales/",
      "https://m.qidian.com/rank/readindex/",
      "https://m.qidian.com/rank/newbook/",
    ]);
    // newbook returned the 202 challenge page and is skipped.
    expect(result.entries).toHaveLength(60);
    expect(result.entries[20]?.extra.startsWith("[起点畅销榜]")).toBe(true);
  });
});
