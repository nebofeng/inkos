import { describe, expect, it } from "vitest";
import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { buildSettlerSystemPrompt, buildSettlerUserPrompt } from "../agents/settler-prompts.js";

const BOOK: BookConfig = {
  id: "settler-prompt-book",
  title: "钟不撒谎",
  platform: "other",
  genre: "mystery",
  status: "active",
  targetChapters: 20,
  chapterWordCount: 2500,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

const GENRE: GenreProfile = {
  id: "mystery",
  name: "悬疑",
  language: "zh",
  chapterTypes: ["调查"],
  fatigueWords: [],
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "",
  satisfactionTypes: [],
  auditDimensions: [],
};

describe("settler hook status vocabulary", () => {
  it("asks for the schema status values instead of Chinese labels", () => {
    const prompt = buildSettlerSystemPrompt(BOOK, GENRE, null, "zh");

    expect(prompt).toContain("status 写 resolved");
    expect(prompt).toContain("status 写成 deferred");
    expect(prompt).toContain("open / progressing / deferred / resolved");
    expect(prompt).not.toMatch(/状态改为"已回收"/);
    expect(prompt).not.toMatch(/标注"延后"/);
  });

  it("does not use 本章 in persisted note examples", () => {
    const prompt = buildSettlerSystemPrompt(BOOK, GENRE, null, "zh");
    const notes = [...prompt.matchAll(/"notes": "([^"]*)"/g)].map((match) => match[1] ?? "");

    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note).not.toContain("本章");
      expect(note).toMatch(/^第\d+章：/);
    }
  });
});

describe("settler hook identity contract", () => {
  it("assigns semantic identity to the settler and keeps host admission structural", () => {
    const prompt = buildSettlerSystemPrompt(BOOK, GENRE, null, "zh");

    expect(prompt).toContain("语义相关的休眠种子");
    expect(prompt).toContain("必须复用它已有的 hookId");
    expect(prompt).toContain("宿主只校验结构");
    expect(prompt).not.toContain("由系统决定它是映射到旧 hook");
  });

  it("labels supplied hooks as active or semantically relevant dormant canon", () => {
    const prompt = buildSettlerUserPrompt({
      chapterNumber: 1,
      title: "慢了十一分钟",
      content: "孙玉珍抱钟进店。",
      currentState: "# 当前状态",
      ledger: "",
      hooks: "| H012 | deferred | 孙玉珍家座钟被回拨 |",
      chapterSummaries: "(文件尚未创建)",
      subplotBoard: "(文件尚未创建)",
      emotionalArcs: "(文件尚未创建)",
      characterMatrix: "(文件尚未创建)",
      volumeOutline: "# 第一卷",
    });

    expect(prompt).toContain("含活跃伏笔与本章语义相关的休眠种子");
    expect(prompt).toContain("H012");
  });
});
