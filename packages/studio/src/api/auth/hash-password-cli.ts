#!/usr/bin/env node
/**
 * Generate a Studio login password hash. The password is read from an
 * interactive prompt (hidden, asked twice) or, when stdin is not a TTY, from
 * the first line of stdin. It is never accepted as a command-line argument.
 *
 *   node dist/api/auth/hash-password-cli.js
 *   printf '%s\n' "$PW" | node dist/api/auth/hash-password-cli.js
 *
 * stdout: `INKOS_STUDIO_PASSWORD_HASH=<hash>` (only line); prompts go to stderr.
 */
import { hashPassword } from "./password.js";

const MIN_LENGTH = 8;

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let value = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          cleanup();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new Error("已取消"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

async function readStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    if (Buffer.concat(chunks).includes(0x0a)) break;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const newline = text.search(/\r?\n/);
  return newline >= 0 ? text.slice(0, newline) : text;
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stderr.write(
      "用法：node hash-password-cli.js            # 交互输入（不回显，输两次）\n"
        + "      printf '%s\\n' \"$PW\" | node hash-password-cli.js   # 从 stdin 读第一行\n"
        + "输出：INKOS_STUDIO_PASSWORD_HASH=scrypt:...（写进 .env，或放进 .inkos/secrets.json 的 studioAuth.passwordHash）\n",
    );
    return 0;
  }
  if (argv.length > 0) {
    process.stderr.write("不接受命令行参数：密码不能放在命令行里（会进 shell 历史和进程列表）。请按提示输入，或从 stdin 传入。\n");
    return 2;
  }

  let password: string;
  try {
    if (process.stdin.isTTY) {
      password = await readHidden("输入 Studio 登录密码：");
      const again = await readHidden("再输入一次：");
      if (password !== again) {
        process.stderr.write("两次输入不一致。\n");
        return 1;
      }
    } else {
      password = await readStdinLine();
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  if (password.length < MIN_LENGTH) {
    process.stderr.write(`密码太短（至少 ${MIN_LENGTH} 个字符）。\n`);
    return 1;
  }
  if (/^\s|\s$/.test(password)) {
    process.stderr.write("提示：密码首尾含空白字符，登录时也必须原样输入。\n");
  }

  const hash = await hashPassword(password);
  process.stdout.write(`INKOS_STUDIO_PASSWORD_HASH=${hash}\n`);
  process.stderr.write("已生成。把上面这一行写进 .env（同时设置 INKOS_STUDIO_USER），然后重新 up -d。哈希里没有 $，可以直接写进 .env。\n");
  return 0;
}

const invokedDirectly = (() => {
  const entry = process.argv[1] ?? "";
  return /hash-password-cli\.(c|m)?(j|t)s$/.test(entry);
})();

if (invokedDirectly) {
  main().then((code) => process.exit(code), (error) => {
    process.stderr.write(`生成失败：${(error as Error).message}\n`);
    process.exit(1);
  });
}
