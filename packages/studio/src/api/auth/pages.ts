/** Self-contained (no SPA bundle needed) Chinese login / refusal pages, mobile-first. */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

/** JSON for embedding inside <script>: escape `<` so `</script>` cannot break out. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Only same-origin relative paths are allowed as a post-login target
 * (no `//host`, no `/\host`, no scheme, no control chars); login/API paths map to "/".
 */
export function sanitizeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "/";
  const value = raw.trim();
  if (!value || value.length > 2048) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login#") || value.startsWith("/api/")) return "/";
  return value;
}

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--fg:#1f1d1a;--muted:#6b6660;--border:#dcd8d0;--accent:#2f5d50;--accent-fg:#fff;--err:#b42318;--err-bg:#fdecea}
@media (prefers-color-scheme:dark){:root{--bg:#141412;--card:#1e1d1b;--fg:#ecebe7;--muted:#a19c94;--border:#3a3833;--accent:#6fb59e;--accent-fg:#0d1a16;--err:#ff8a7a;--err-bg:#3a1d19}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;-webkit-text-size-adjust:100%}
body{display:flex;min-height:100vh;min-height:100dvh;align-items:center;justify-content:center;padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))}
main{width:100%;max-width:400px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 22px;box-shadow:0 8px 30px rgba(0,0,0,.06)}
h1{margin:0 0 4px;font-size:24px;line-height:1.3}
.sub{margin:0 0 22px;color:var(--muted);font-size:15px}
label{display:block;margin:0 0 6px;font-size:15px;font-weight:600}
.field{margin-bottom:18px}
input[type=text],input[type=password]{display:block;width:100%;min-height:52px;padding:12px 14px;font-size:17px;color:var(--fg);background:transparent;border:1px solid var(--border);border-radius:12px;outline:none;-webkit-appearance:none;appearance:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
.pw{position:relative}
.pw input{padding-right:76px}
.toggle{position:absolute;right:4px;top:4px;bottom:4px;min-width:64px;border:0;border-radius:10px;background:transparent;color:var(--muted);font-size:15px;cursor:pointer}
.btn{display:block;width:100%;min-height:54px;margin-top:6px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-fg);font-size:18px;font-weight:700;cursor:pointer;touch-action:manipulation}
.btn[disabled]{opacity:.6;cursor:progress}
.err{display:none;margin:0 0 16px;padding:12px 14px;border-radius:12px;background:var(--err-bg);color:var(--err);font-size:15px}
.err.show{display:block}
.foot{margin:16px 4px 0;color:var(--muted);font-size:13px;text-align:center}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
pre{white-space:pre-wrap;word-break:break-all;background:color-mix(in srgb,var(--border) 35%,transparent);padding:10px 12px;border-radius:10px}
`;

export function renderLoginPage(options: { readonly next: string; readonly nonce: string; readonly error?: string; readonly appName?: string }): string {
  const appName = escapeHtml(options.appName ?? "InkOS Studio");
  const next = sanitizeNextPath(options.next);
  const nonce = escapeHtml(options.nonce);
  const initialError = options.error ? escapeHtml(options.error) : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="same-origin">
<title>登录 · ${appName}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📜</text></svg>">
<style nonce="${nonce}">${BASE_CSS}</style>
</head>
<body>
<main>
  <div class="card">
    <h1>${appName}</h1>
    <p class="sub">请登录后继续</p>
    <div id="err" class="err${initialError ? " show" : ""}" role="alert" aria-live="assertive">${initialError}</div>
    <form id="login" method="post" action="/api/v1/auth/login" novalidate>
      <input type="hidden" name="next" id="next" value="${escapeHtml(next)}">
      <div class="field">
        <label for="username">用户名</label>
        <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="text" required autofocus>
      </div>
      <div class="field">
        <label for="password">密码</label>
        <div class="pw">
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <button type="button" class="toggle" id="toggle" aria-label="显示密码" aria-pressed="false">显示</button>
        </div>
      </div>
      <button class="btn" id="submit" type="submit">登录</button>
    </form>
  </div>
  <p class="foot">登录状态保持 30 天，可在侧边栏底部「退出登录」。</p>
</main>
<script nonce="${nonce}">
(function(){
  var NEXT=${scriptJson(next)};
  var form=document.getElementById("login"),err=document.getElementById("err"),btn=document.getElementById("submit");
  var pw=document.getElementById("password"),toggle=document.getElementById("toggle"),user=document.getElementById("username");
  function target(){var n=NEXT;if(n.indexOf("#")<0&&location.hash&&location.hash.length>1)n+=location.hash;return n;}
  document.getElementById("next").value=target();
  function show(msg){err.textContent=msg;err.className="err show";}
  toggle.addEventListener("click",function(){var on=pw.type==="password";pw.type=on?"text":"password";toggle.textContent=on?"隐藏":"显示";toggle.setAttribute("aria-pressed",on?"true":"false");toggle.setAttribute("aria-label",on?"隐藏密码":"显示密码");pw.focus();});
  form.addEventListener("submit",function(ev){
    ev.preventDefault();
    if(!user.value.trim()||!pw.value){show("请输入用户名和密码");return;}
    btn.disabled=true;btn.textContent="登录中…";
    fetch("/api/v1/auth/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({username:user.value.trim(),password:pw.value})})
      .then(function(res){return res.json().catch(function(){return {};}).then(function(body){return {res:res,body:body};});})
      .then(function(r){
        if(r.res.ok){location.replace(target());return;}
        var msg=(r.body&&r.body.error&&r.body.error.message)||"登录失败，请重试";
        if(r.res.status===429){var s=parseInt(r.res.headers.get("Retry-After")||"0",10);if(s>0)msg="尝试次数过多，已暂时锁定，请约 "+Math.max(1,Math.ceil(s/60))+" 分钟后再试";}
        show(msg);pw.value="";pw.focus();
      })
      .catch(function(){show("网络错误，请检查连接后重试");})
      .then(function(){btn.disabled=false;btn.textContent="登录";});
  });
})();
</script>
</body>
</html>`;
}

/** Default (InkOS Docker) setup instructions shown on the refusal page; trusted HTML. */
export const INKOS_SETUP_HINT_HTML = `<p>请管理员在服务器上生成密码哈希并写入 <code>.env</code>：</p>
    <pre>docker-compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs
# 插件版：docker compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs
# 非 Docker：node &lt;inkos-studio 包目录&gt;/dist/api/auth/hash-password-cli.js</pre>
    <p>然后在 <code>.env</code> 里设置 <code>INKOS_STUDIO_USER</code> 和 <code>INKOS_STUDIO_PASSWORD_HASH</code>，重新 <code>up -d</code>。详见部署 README。</p>`;

export function renderUnconfiguredPage(options: {
  readonly reason: string;
  readonly nonce: string;
  readonly appName?: string;
  /** Trusted HTML with setup steps (not user input). */
  readonly setupHintHtml?: string;
}): string {
  const nonce = escapeHtml(options.nonce);
  const appName = escapeHtml(options.appName ?? "InkOS Studio");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>未配置登录 · ${appName}</title>
<style nonce="${nonce}">${BASE_CSS}</style>
</head>
<body>
<main>
  <div class="card">
    <h1>${appName} 暂不可用</h1>
    <p class="sub">还没有配置登录账号，为了安全已拒绝所有访问。</p>
    <div class="err show" role="alert">${escapeHtml(options.reason)}</div>
    ${options.setupHintHtml ?? INKOS_SETUP_HINT_HTML}
  </div>
</main>
</body>
</html>`;
}
