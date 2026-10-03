import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeRuntimeStateDeltaPayload,
  parseSettlerDeltaOutput,
} from "../agents/settler-delta-parser.js";

// Structure, hook ids, statuses and timings taken from a real chapter-13
// settlement that InkOS 1.8.0 rejected (text fields replaced by placeholders).
const ch13 = readFileSync(
  new URL("./fixtures/settler/settler-delta-ch13-aliases.txt", import.meta.url),
  "utf-8",
);

function deltaBlock(payload: unknown): string {
  return [
    "=== POST_SETTLEMENT ===",
    "要点",
    "",
    "=== RUNTIME_STATE_DELTA ===",
    "```json",
    JSON.stringify(payload),
    "```",
  ].join("\n");
}

function upsert(hookId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    hookId,
    startChapter: 3,
    type: "mystery",
    status,
    lastAdvancedChapter: 13,
    expectedPayoff: "揭开",
    notes: "第13章：推进",
    ...extra,
  };
}

describe("settler delta status normalization", () => {
  it("accepts the real ch13 settlement that used pressured / 已回收", () => {
    const result = parseSettlerDeltaOutput(ch13);
    const statuses = Object.fromEntries(
      result.runtimeStateDelta.hookOps.upsert.map((hook) => [hook.hookId, hook.status]),
    );
    expect(statuses.H020).toBe("progressing");
    expect(statuses.H024).toBe("resolved");
    expect(statuses.H025).toBe("resolved");
    expect(result.runtimeStateDelta.hookOps.resolve).toEqual(["H024", "H025"]);
    expect(result.normalizations).toEqual([
      'upsert:H020 status "pressured" -> progressing',
      'upsert:H024 status "已回收" -> resolved',
      'upsert:H025 status "已回收" -> resolved',
    ]);
  });

  it("strips ledger annotations echoed back as status", () => {
    const result = parseSettlerDeltaOutput(deltaBlock({
      chapter: 9,
      hookOps: {
        upsert: [
          upsert("H005", "deferred (受阻于 H001 (已阻 8 章))"),
          upsert("H006", "延后"),
          upsert("H007", "progressing（受阻）"),
        ],
      },
    }));
    expect(result.runtimeStateDelta.hookOps.upsert.map((hook) => hook.status))
      .toEqual(["deferred", "deferred", "progressing"]);
  });

  it("maps Chinese payoff timings and drops unknown ones instead of failing", () => {
    const result = parseSettlerDeltaOutput(deltaBlock({
      chapter: 9,
      hookOps: { upsert: [upsert("H001", "open", { payoffTiming: "慢烧" }), upsert("H002", "open", { payoffTiming: "第20章" })] },
      newHookCandidates: [{ type: "mystery", expectedPayoff: "x", payoffTiming: "近期", notes: "n" }],
    }));
    expect(result.runtimeStateDelta.hookOps.upsert[0]?.payoffTiming).toBe("slow-burn");
    expect(result.runtimeStateDelta.hookOps.upsert[1]?.payoffTiming).toBeUndefined();
    expect(result.runtimeStateDelta.newHookCandidates[0]?.payoffTiming).toBe("near-term");
  });

  it("still rejects statuses it cannot interpret", () => {
    expect(() => parseSettlerDeltaOutput(deltaBlock({
      chapter: 9,
      hookOps: { upsert: [upsert("H001", "maybe-later?")] },
    }))).toThrow(/schema validation/);
  });

  it("leaves valid payloads untouched", () => {
    const payload = { chapter: 2, hookOps: { upsert: [upsert("H001", "open", { payoffTiming: "mid-arc" })] } };
    expect(normalizeRuntimeStateDeltaPayload(payload)).toEqual([]);
    expect(parseSettlerDeltaOutput(deltaBlock(payload)).normalizations).toBeUndefined();
  });
});
