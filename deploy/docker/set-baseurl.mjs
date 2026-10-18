// 迁移辅助：修改 <项目>/inkos.json 里某个模型服务的 baseUrl（先备份成 inkos.json.bak-<时间>-baseurl）。
// 用法（在 compose 目录）：
//   docker compose run --rm --no-deps inkos node /usr/local/lib/inkos/set-baseurl.mjs http://sub2api:8080/v1 [服务ID]
// 服务ID 默认取 inkos.json 的 llm.service（服务器3 上是 custom:sub2api）。不碰任何 key。
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [url, wanted] = process.argv.slice(2);
if (!url || !/^https?:\/\//.test(url)) {
  console.error("用法: set-baseurl.mjs <http(s)://新地址/v1> [服务ID]");
  process.exit(2);
}
const root = process.env.INKOS_PROJECT_ROOT ?? "/data";
const file = join(root, "inkos.json");
const cfg = JSON.parse(readFileSync(file, "utf8"));
const llm = cfg.llm ?? (cfg.llm = {});
const target = wanted ?? llm.service;
if (!target) {
  console.error("inkos.json 里没有 llm.service，请显式给出服务ID");
  process.exit(2);
}
const idOf = (s) => ((s.service ?? "custom") === "custom" ? `custom:${s.name ?? "Custom"}` : s.service);
let hit = 0;
const services = Array.isArray(llm.services) ? llm.services : [];
for (const s of services) {
  if (s && typeof s === "object" && idOf(s) === target) {
    console.log(`services[${target}].baseUrl: ${s.baseUrl ?? "(空)"} -> ${url}`);
    s.baseUrl = url;
    hit++;
  }
}
if (llm.service === target) {
  console.log(`llm.baseUrl: ${llm.baseUrl ?? "(空)"} -> ${url}`);
  llm.baseUrl = url;
  hit++;
}
if (!hit) {
  console.error(`没找到服务 ${target}；现有服务：${services.map(idOf).join(", ") || "(无)"}`);
  process.exit(1);
}
const d = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const bak = `${file}.bak-${stamp}-baseurl`;
copyFileSync(file, bak);
writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
console.log(`已写入 ${file}（备份 ${bak}）`);
