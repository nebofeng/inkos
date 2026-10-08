// 生成 Studio 登录密码哈希（scrypt）。密码只从交互提示（不回显、输两次）或 stdin 读，不接受命令行参数。
//   docker-compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs
//   （插件版：docker compose run --rm --no-deps inkos node /usr/local/lib/inkos/hash-password.mjs）
// 输出一行 INKOS_STUDIO_PASSWORD_HASH=scrypt:...，写进 .env。实现在 @actalk/inkos-studio（feat/studio-auth）。
import { main } from "/app/node_modules/@actalk/inkos-studio/dist/api/auth/hash-password-cli.js";

process.exit(await main(process.argv.slice(2)));
