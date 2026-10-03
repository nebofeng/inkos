/**
 * Synthetic story-graph fixture. All names and text are invented placeholders
 * (no novel text from real books — the fork is public).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChapterGraphExtraction, ChapterGraphExtractor, ChapterGraphExtractorInput } from "../../story-graph/types.js";

export const FIXTURE_MATRIX = `# 角色矩阵

## 林砚（阿砚）
- **定位**: 主角
- **外号**: 砚哥、小林
- **当前**: 在旧码头仓库外，不要写成已经死亡
- **关系**: 周岚(合伙查账的搭档/Ch3) | 韩铎(追债的对头/Ch4)

## 周岚
- **定位**: 女主，账房
- **别名**: 岚姐
- **关系**: 林砚(搭档/Ch3)

## 韩铎
- **定位**: 反派，债主
- **关系**: 林砚(追债的对头/Ch4)

## 老秦
- **定位**: 配角，码头看门人
- **状态**: 已故，第5章死于火灾
`;

export const FIXTURE_CHAPTERS: Record<number, { title: string; body: string }> = {
  1: { title: "占位标题一", body: "林砚推开门。\n“账本不在这里。”林砚说。\n周岚没有抬头：“那就去码头找。”\n" },
  2: { title: "占位标题二", body: "码头风很大。老秦守着仓库。\n老秦说：“夜里别来，这里不干净。”\n林砚记下了这句话。\n" },
  3: { title: "占位标题三", body: "周岚和林砚把账对完了。\n岚姐说：“缺的那笔，在韩铎手里。”\n小林点头：“我答应你，三天内拿回来。”\n" },
  4: { title: "占位标题四", body: "韩铎带人堵住了巷口。\n韩铎说：“欠的钱，月底之前还清。”\n林砚没有退。\n" },
  5: { title: "占位标题五", body: "仓库起火。老秦没能出来。\n林砚在灰里找到一枚铜钥匙。\n" },
  6: { title: "占位标题六", body: "周岚看着铜钥匙：“这是老秦的东西。”\n林砚把钥匙收好。\n" },
};

export const FIXTURE_EXTRACTIONS: Record<number, ChapterGraphExtraction> = {
  1: {
    characters: [{ name: "林砚", role: "主角" }, { name: "周岚" }],
    factions: [], items: [{ name: "账本" }], locations: [{ name: "码头" }],
    events: [{ summary: "林砚和周岚发现账本不在屋里，决定去码头找", participants: ["林砚", "周岚"], importance: 2 }],
    relationships: [{ from: "林砚", to: "周岚", type: "搭档", strength: 0.6 }],
    dialogues: [
      { speaker: "林砚", addressee: "周岚", quote: "账本不在这里。" },
      { speaker: "周岚", addressee: "林砚", quote: "那就去码头找。" },
    ],
  },
  2: {
    characters: [{ name: "老秦", role: "看门人" }, { name: "林砚" }],
    factions: [], items: [], locations: [{ name: "仓库" }],
    events: [{ summary: "老秦警告林砚夜里别来仓库", participants: ["老秦", "林砚"], location: "仓库", importance: 2 }],
    relationships: [{ from: "老秦", to: "林砚", type: "提醒者", strength: 0.4 }],
    dialogues: [{ speaker: "老秦", addressee: "林砚", quote: "夜里别来，这里不干净。" }],
  },
  3: {
    characters: [{ name: "岚姐", aliases: [] }, { name: "小林" }, { name: "韩铎" }],
    factions: [], items: [], locations: [],
    events: [
      { summary: "周岚和林砚对完账，确认缺口在韩铎手里", participants: ["周岚", "林砚", "韩铎"], importance: 3 },
    ],
    relationships: [
      { from: "林砚", to: "周岚", type: "搭档", strength: 0.8 },
      // Polarity contradicts the matrix ("对头") → must be dropped.
      { from: "林砚", to: "韩铎", type: "盟友", strength: 0.7 },
    ],
    dialogues: [
      { speaker: "岚姐", addressee: "林砚", quote: "缺的那笔，在韩铎手里。" },
      { speaker: "小林", addressee: "周岚", quote: "我答应你，三天内拿回来。" },
      // Not in the text → must be dropped as unverifiable.
      { speaker: "林砚", quote: "我一定会报仇。" },
    ],
  },
  4: {
    characters: [{ name: "韩铎", role: "债主" }, { name: "林砚" }],
    factions: [{ name: "码头帮" }], items: [], locations: [{ name: "巷口" }],
    events: [{ summary: "韩铎带人堵住巷口，逼林砚月底还钱", participants: ["韩铎", "林砚"], location: "巷口", importance: 3 }],
    relationships: [{ from: "韩铎", to: "林砚", type: "对头", strength: 0.9 }],
    dialogues: [{ speaker: "韩铎", addressee: "林砚", quote: "欠的钱，月底之前还清。" }],
  },
  5: {
    // Extraction claims alive; matrix says 已故 → truth wins.
    characters: [{ name: "老秦", status: "alive" }, { name: "林砚" }],
    factions: [], items: [{ name: "铜钥匙", owner: "林砚" }], locations: [{ name: "仓库" }],
    events: [{ summary: "仓库起火，老秦没能逃出，林砚在灰里捡到铜钥匙", participants: ["老秦", "林砚"], location: "仓库", importance: 3 }],
    relationships: [],
    dialogues: [],
  },
  6: {
    characters: [{ name: "周岚" }, { name: "林砚" }],
    factions: [], items: [{ name: "铜钥匙", owner: "林砚" }], locations: [],
    events: [{ summary: "周岚认出铜钥匙属于老秦", participants: ["周岚", "林砚", "老秦"], importance: 2 }],
    relationships: [{ from: "周岚", to: "林砚", type: "搭档", strength: 0.9 }],
    dialogues: [{ speaker: "周岚", addressee: "林砚", quote: "这是老秦的东西。" }],
  },
};

export class FixtureExtractor implements ChapterGraphExtractor {
  readonly id = "mock:fixture";
  readonly calls: number[] = [];

  async extract(input: ChapterGraphExtractorInput): Promise<ChapterGraphExtraction> {
    this.calls.push(input.chapterNumber);
    const extraction = FIXTURE_EXTRACTIONS[input.chapterNumber];
    if (!extraction) throw new Error(`no fixture for chapter ${input.chapterNumber}`);
    return structuredClone(extraction);
  }
}

export async function writeFixtureBook(bookDir: string, chapters: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6]): Promise<void> {
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "story"), { recursive: true });
  await writeFile(join(bookDir, "story", "character_matrix.md"), FIXTURE_MATRIX, "utf-8");
  for (const chapter of chapters) {
    const { title, body } = FIXTURE_CHAPTERS[chapter]!;
    await writeFile(
      join(bookDir, "chapters", `${String(chapter).padStart(4, "0")}_${title}.md`),
      `# 第${chapter}章 ${title}\n\n${body}`,
      "utf-8",
    );
  }
}
