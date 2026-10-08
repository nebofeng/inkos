// daemon 启动前的模型配置检查：用 InkOS 自己的配置解析（和 `inkos up` 完全同一套逻辑，只读文件，不发网络请求）。
// 解析失败（如 inkos.json 没有 llm.services、没有 key：'INKOS_LLM_API_KEY not set'）时打印清楚的原因并以 78 退出，
// entrypoint 据此不再启动 daemon；compose 的 restart: on-failure:N 会在 N 次后停下，不会无限重启。
// 只打印服务/模型/地址/key 来源，绝不打印 key 的值。
const root = process.env.INKOS_PROJECT_ROOT ?? "/data";
const EX_CONFIG = 78;
let mod;
try {
  mod = await import("/app/dist/utils.js");
} catch (e) {
  console.error(`[llm-check] 加载 InkOS CLI 失败（镜像问题，不是配置问题）：${e instanceof Error ? e.message : e}`);
  process.exit(70);
}
try {
  const { config, diagnostics } = await mod.loadConfigWithDiagnostics({ projectRoot: root });
  const llm = config.llm ?? {};
  console.error(
    `[llm-check] 模型配置 OK：mode=${diagnostics?.configMode ?? "?"} service=${llm.service ?? "-"} ` +
      `model=${llm.model ?? "-"} baseUrl=${llm.baseUrl ?? "-"} key来源=${diagnostics?.apiKeySource ?? "?"}`,
  );
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[llm-check] ==================================================================");
  console.error("[llm-check] 模型（LLM）配置不可用，daemon 不启动（退出码 78）。");
  console.error(`[llm-check] 原因：${msg}`);
  console.error(`[llm-check] 检查 ${root}/inkos.json 的 llm.services / llm.service，以及 key：`);
  console.error("[llm-check]   - 推荐：key 放在 data/.inkos/secrets.json（在 Studio「服务」页保存，或从服务器3 迁过来）");
  console.error("[llm-check]   - 或 .env 里 INKOS_SECRETS_FROM_ENV=1 + <服务ID>_API_KEY（如 CUSTOM_SUB2API_API_KEY）");
  console.error("[llm-check] 改好后：docker-compose up -d inkos-daemon（插件版：docker compose up -d inkos-daemon）");
  console.error("[llm-check] ==================================================================");
  process.exit(EX_CONFIG);
}
