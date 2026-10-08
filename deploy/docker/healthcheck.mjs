// 容器健康检查。
//   node healthcheck.mjs          Studio：GET http://127.0.0.1:$INKOS_STUDIO_PORT/api/v1/daemon 返回 2xx
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
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/daemon`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) {
    console.error(`studio unhealthy: HTTP ${res.status}`);
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  console.error(`studio unhealthy: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
