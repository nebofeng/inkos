// 容器健康检查。
//   node healthcheck.mjs          Studio：GET http://127.0.0.1:$INKOS_STUDIO_PORT/healthz 返回 200 且 {"ok":true}
//                                 （/healthz 不需要登录，也不返回书名、key、路径、版本；登录未配置时返回 503 → unhealthy）
//   node healthcheck.mjs daemon   daemon：$INKOS_PROJECT_ROOT/inkos.pid 里的进程还活着
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2] ?? "studio";
const root = process.env.INKOS_PROJECT_ROOT ?? "/data";

if (mode === "daemon") {
  try {
    const pid = Number.parseInt(readFileSync(join(root, "inkos.pid"), "utf8").trim(), 10);
    process.kill(pid, 0);
    process.exit(0);
  } catch (e) {
    console.error(`daemon unhealthy: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

const port = process.env.INKOS_STUDIO_PORT ?? "4567";
try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || body?.ok !== true) {
    console.error(`studio unhealthy: HTTP ${res.status}${res.status === 503 ? "（Studio 登录未配置？看 docker-compose logs inkos 里的 [studio-auth]）" : ""}`);
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  console.error(`studio unhealthy: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
