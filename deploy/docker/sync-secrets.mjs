// INKOS_SECRETS_FROM_ENV=1 时由 entrypoint 调用：把环境变量里的 API key 写进 <项目>/.inkos/secrets.json。
// InkOS 的 Studio 模式只从 .inkos/secrets.json 读 key，这样 .env 就是 key 的唯一来源。
// 变量名沿用 InkOS 自己的规则：服务 ID 里非字母数字换成 "_"，转大写，加 "_API_KEY"。
//   例：inkos.json 里 {"service":"custom","name":"sub2api"} -> 服务 ID custom:sub2api -> CUSTOM_SUB2API_API_KEY
// 只打印服务 ID 和变量名，绝不打印 key 的值。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.env.INKOS_PROJECT_ROOT ?? "/data";
const tag = "[sync-secrets]";

let cfg;
try {
  cfg = JSON.parse(readFileSync(join(root, "inkos.json"), "utf8"));
} catch (e) {
  console.error(`${tag} 读 inkos.json 失败，跳过：${e instanceof Error ? e.message : e}`);
  process.exit(0);
}

const ids = new Set();
const services = Array.isArray(cfg?.llm?.services) ? cfg.llm.services : [];
for (const s of services) {
  if (!s || typeof s !== "object") continue;
  const svc = typeof s.service === "string" && s.service ? s.service : "custom";
  ids.add(svc === "custom" ? `custom:${s.name ?? "Custom"}` : svc);
}
if (typeof cfg?.llm?.service === "string" && cfg.llm.service && cfg.llm.service !== "custom") ids.add(cfg.llm.service);

const envName = (id) => `${id.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`;

const dir = join(root, ".inkos");
const file = join(dir, "secrets.json");
let secrets = { services: {} };
if (existsSync(file)) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.services && typeof parsed.services === "object") secrets = parsed;
  } catch {
    console.error(`${tag} 现有 secrets.json 不是合法 JSON，将重写`);
  }
}

const changed = [];
for (const id of ids) {
  const name = envName(id);
  const value = process.env[name];
  if (!value) {
    console.error(`${tag} ${id}: 未设置 ${name}，保持 secrets.json 原值`);
    continue;
  }
  if (secrets.services[id]?.apiKey !== value) {
    secrets.services[id] = { ...(secrets.services[id] ?? {}), apiKey: value };
    changed.push(`${id}<-${name}`);
  }
}

if (changed.length === 0) {
  console.error(`${tag} 无变化`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const tmp = `${file}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
chmodSync(tmp, 0o600);
renameSync(tmp, file);
console.error(`${tag} 已更新：${changed.join(", ")}`);
