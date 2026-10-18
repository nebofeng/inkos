/**
 * Resolve Studio login configuration from env / .inkos/secrets.json.
 *
 * Precedence (first match wins, per field group):
 *   credentials:    env INKOS_STUDIO_USER + INKOS_STUDIO_PASSWORD_HASH
 *                   → secrets.json `studioAuth.user` + `studioAuth.passwordHash`
 *   session secret: env INKOS_STUDIO_SESSION_SECRET
 *                   → secrets.json `studioAuth.sessionSecret`
 *                   → <data>/.inkos/studio-session-secret (auto-generated, 0600)
 *
 * Default is "auth on". With no credentials the server refuses access (it does
 * not fail open). INKOS_STUDIO_AUTH=off disables login entirely (dangerous).
 *
 * Names are the InkOS defaults; another service reuses this module by passing
 * `names` (env prefix, trusted-proxy variable, secrets file/field, state dir).
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPasswordHash } from "./password.js";
import { InvalidTrustedProxyError, parseTrustedProxies, type TrustedProxies } from "./client-ip.js";

export const SESSION_SECRET_FILE = "studio-session-secret";
export const REVOCATION_FILE = "studio-auth-revoked.json";
const MIN_SESSION_SECRET_LENGTH = 32;
const USER_PATTERN = /^[^\s:]{1,64}$/;

type Env = Readonly<Record<string, string | undefined>>;

/** Where configuration lives. Defaults = InkOS Studio. */
export interface AuthConfigNames {
  /** Env prefix: <prefix>USER, <prefix>PASSWORD_HASH, <prefix>SESSION_SECRET, <prefix>COOKIE_SECURE, <prefix>AUTH, <prefix>PASSWORD. */
  readonly envPrefix: string;
  readonly trustedProxiesEnv: string;
  /** State dir relative to the data root (session secret, revocation list). */
  readonly stateDir: string;
  /** Optional JSON secrets file relative to the data root, and the object field holding { user, passwordHash, sessionSecret }. */
  readonly secretsFile: string | null;
  readonly secretsField: string;
}

export const INKOS_AUTH_CONFIG_NAMES: AuthConfigNames = {
  envPrefix: "INKOS_STUDIO_",
  trustedProxiesEnv: "INKOS_TRUSTED_PROXIES",
  stateDir: ".inkos",
  secretsFile: ".inkos/secrets.json",
  secretsField: "studioAuth",
};

export interface StudioAuthEnabledConfig {
  readonly mode: "enabled";
  readonly user: string;
  readonly passwordHash: string;
  readonly credentialSource: "env" | "secrets.json";
  readonly sessionSecret: string;
  readonly sessionSecretSource: "env" | "secrets.json" | "file" | "generated";
  readonly cookieSecure: boolean;
  readonly trustedProxies: TrustedProxies;
  readonly revocationFile: string | null;
  readonly warnings: ReadonlyArray<string>;
}

export interface StudioAuthDisabledConfig {
  readonly mode: "disabled";
  readonly warnings: ReadonlyArray<string>;
}

export interface StudioAuthUnconfigured {
  readonly mode: "unconfigured";
  readonly reason: string;
  readonly warnings: ReadonlyArray<string>;
}

export type StudioAuthConfig = StudioAuthEnabledConfig | StudioAuthDisabledConfig | StudioAuthUnconfigured;

function isFalsy(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test(String(value ?? "").trim());
}

async function readStudioSecrets(root: string, names: AuthConfigNames): Promise<Record<string, unknown>> {
  if (!names.secretsFile) return {};
  try {
    const parsed = JSON.parse(await readFile(join(root, names.secretsFile), "utf8")) as Record<string, unknown>;
    const studio = parsed?.[names.secretsField];
    return studio && typeof studio === "object" ? (studio as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function loadOrCreateSessionSecretFile(root: string, stateDir: string): Promise<{ secret: string; created: boolean }> {
  const dir = join(root, stateDir);
  const filePath = join(dir, SESSION_SECRET_FILE);
  try {
    const existing = (await readFile(filePath, "utf8")).trim();
    if (existing.length >= MIN_SESSION_SECRET_LENGTH) {
      const info = await stat(filePath);
      if ((info.mode & 0o077) !== 0) await chmod(filePath, 0o600).catch(() => undefined);
      return { secret: existing, created: false };
    }
  } catch {
    // fall through: create
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("base64url");
  try {
    await writeFile(filePath, `${secret}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    // Lost a race with another process, or a short/corrupt file exists: re-read or overwrite.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = (await readFile(filePath, "utf8")).trim();
      if (existing.length >= MIN_SESSION_SECRET_LENGTH) return { secret: existing, created: false };
      await writeFile(filePath, `${secret}\n`, { mode: 0o600 });
    } else {
      throw error;
    }
  }
  await chmod(filePath, 0o600);
  return { secret, created: true };
}

export async function resolveStudioAuthConfig(options: {
  readonly root: string;
  readonly env: Env;
  readonly names?: Partial<AuthConfigNames>;
}): Promise<StudioAuthConfig> {
  const { root, env } = options;
  const names: AuthConfigNames = { ...INKOS_AUTH_CONFIG_NAMES, ...options.names };
  const P = names.envPrefix;
  const V = {
    user: `${P}USER`,
    hash: `${P}PASSWORD_HASH`,
    plain: `${P}PASSWORD`,
    secret: `${P}SESSION_SECRET`,
    secure: `${P}COOKIE_SECURE`,
    auth: `${P}AUTH`,
    proxies: names.trustedProxiesEnv,
    field: names.secretsField,
  };
  const warnings: string[] = [];

  if (env[V.plain] !== undefined && env[V.plain] !== "") {
    warnings.push(`检测到 ${V.plain}（明文密码），已忽略。请改用 ${V.hash}（用 hash-password 生成），并删除明文变量。`);
  }

  const authSwitch = String(env[V.auth] ?? "").trim().toLowerCase();
  if (authSwitch === "off") {
    warnings.push(`${V.auth}=off：登录已关闭，任何能访问端口的人都能读写数据和 key。只允许在本机临时调试时使用！`);
    return { mode: "disabled", warnings };
  }
  if (authSwitch !== "" && authSwitch !== "on") {
    return { mode: "unconfigured", reason: `${V.auth} 只能是 on 或 off（当前值无效）`, warnings };
  }

  const studioSecrets = await readStudioSecrets(root, names);
  const envUser = (env[V.user] ?? "").trim();
  const envHash = (env[V.hash] ?? "").trim();

  let user = "";
  let passwordHash = "";
  let credentialSource: "env" | "secrets.json";
  if (envUser || envHash) {
    if (!envUser || !envHash) {
      return {
        mode: "unconfigured",
        reason: `${V.user} 和 ${V.hash} 必须同时设置（现在只设置了其中一个）`,
        warnings,
      };
    }
    user = envUser;
    passwordHash = envHash;
    credentialSource = "env";
  } else {
    user = typeof studioSecrets.user === "string" ? studioSecrets.user.trim() : "";
    passwordHash = typeof studioSecrets.passwordHash === "string" ? studioSecrets.passwordHash.trim() : "";
    credentialSource = "secrets.json";
    if (!user && !passwordHash) {
      return {
        mode: "unconfigured",
        reason: `没有配置登录账号：请设置 ${V.user} 和 ${V.hash}${names.secretsFile ? `（或 ${names.secretsFile} 的 ${V.field}.user / ${V.field}.passwordHash）` : ""}`,
        warnings,
      };
    }
    if (!user || !passwordHash) {
      return { mode: "unconfigured", reason: `${names.secretsFile} 的 ${V.field}.user 和 ${V.field}.passwordHash 必须同时设置`, warnings };
    }
  }
  if (!USER_PATTERN.test(user)) {
    return { mode: "unconfigured", reason: "用户名不能为空、不能含空白或冒号，最长 64 个字符", warnings };
  }
  if (!isPasswordHash(passwordHash)) {
    return {
      mode: "unconfigured",
      reason: `${credentialSource === "env" ? V.hash : `${V.field}.passwordHash`} 不是有效的 scrypt 哈希（格式 scrypt:N:r:p:salt:hash）。不要填明文密码，请用 hash-password 生成`,
      warnings,
    };
  }

  let trustedProxies: TrustedProxies;
  try {
    trustedProxies = parseTrustedProxies(env[V.proxies]);
  } catch (error) {
    if (error instanceof InvalidTrustedProxyError) {
      return { mode: "unconfigured", reason: `${V.proxies} 无效：${error.message}`, warnings };
    }
    throw error;
  }

  let sessionSecret = (env[V.secret] ?? "").trim();
  let sessionSecretSource: StudioAuthEnabledConfig["sessionSecretSource"] = "env";
  if (sessionSecret) {
    if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
      return { mode: "unconfigured", reason: `${V.secret} 太短（至少 ${MIN_SESSION_SECRET_LENGTH} 个字符）`, warnings };
    }
  } else if (typeof studioSecrets.sessionSecret === "string" && studioSecrets.sessionSecret.trim()) {
    sessionSecret = studioSecrets.sessionSecret.trim();
    sessionSecretSource = "secrets.json";
    if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
      return { mode: "unconfigured", reason: `${V.field}.sessionSecret 太短（至少 ${MIN_SESSION_SECRET_LENGTH} 个字符）`, warnings };
    }
  } else {
    try {
      const loaded = await loadOrCreateSessionSecretFile(root, names.stateDir);
      sessionSecret = loaded.secret;
      sessionSecretSource = loaded.created ? "generated" : "file";
    } catch (error) {
      return {
        mode: "unconfigured",
        reason: `无法在数据目录生成会话密钥文件 ${names.stateDir}/${SESSION_SECRET_FILE}（${(error as Error).message}）。请检查 data/ 的属主（应为容器 uid）或设置 ${V.secret}`,
        warnings,
      };
    }
  }

  const cookieSecure = !isFalsy(env[V.secure]);
  if (!cookieSecure) {
    warnings.push(`${V.secure}=0：登录 cookie 不带 Secure，只能用于本机 http 测试，生产环境（https）请删掉这一项。`);
  }

  return {
    mode: "enabled",
    user,
    passwordHash,
    credentialSource,
    sessionSecret,
    sessionSecretSource,
    cookieSecure,
    trustedProxies,
    revocationFile: join(root, names.stateDir, REVOCATION_FILE),
    warnings,
  };
}
