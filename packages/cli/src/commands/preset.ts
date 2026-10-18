import { Command } from "commander";
import {
  getPlatformPreset,
  listPlatformPresets,
  resolvePlatformPreset,
  type PlatformPreset,
} from "@actalk/inkos-core";
import { log, logError } from "../utils.js";

export const presetCommand = new Command("preset")
  .description("List or show writing-platform presets");

presetCommand
  .command("list")
  .description("List writing-platform presets")
  .option("--json", "Output JSON")
  .action((opts: { json?: boolean }) => {
    const presets = listPlatformPresets();
    if (opts.json) {
      log(JSON.stringify(presets.map(toPublicPreset), null, 2));
      return;
    }
    for (const preset of presets) {
      const words = preset.chapterWords;
      const count = preset.chapterCount
        ? `  chapters ${preset.chapterCount.recommendedMin}-${preset.chapterCount.recommendedMax} (max ${preset.chapterCount.max})`
        : "";
      log(`${preset.id}\t${preset.name}\t${words.min}-${words.max} (target ${words.target})${count}`);
    }
  });

presetCommand
  .command("show")
  .description("Show one writing-platform preset")
  .argument("<id>", "Preset id (jinjiang is accepted as an alias of jjwxc)")
  .option("--json", "Output JSON")
  .action((id: string, opts: { json?: boolean }) => {
    const preset = resolvePlatformPreset(id) ?? getPlatformPreset(id);
    if (!preset) {
      logError(`Unknown platform preset: ${id}`);
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      log(JSON.stringify(toPublicPreset(preset), null, 2));
      return;
    }
    log(`${preset.id}  ${preset.name}`);
    log(`chapterWords: ${preset.chapterWords.min}-${preset.chapterWords.max} (target ${preset.chapterWords.target})`);
    if (preset.chapterCount) {
      log(`chapterCount: ${preset.chapterCount.min}-${preset.chapterCount.max} (default ${preset.chapterCount.defaultCount}, suggested ${preset.chapterCount.recommendedMin}-${preset.chapterCount.recommendedMax})`);
    }
    log(`aiFlavorThreshold: ${preset.aiFlavorThreshold}`);
    log("");
    log(preset.promptBlock);
  });

function toPublicPreset(preset: PlatformPreset) {
  return {
    id: preset.id,
    name: preset.name,
    chapterWords: preset.chapterWords,
    chapterCount: preset.chapterCount,
    aiFlavorThreshold: preset.aiFlavorThreshold,
    promptBlock: preset.promptBlock,
  };
}
