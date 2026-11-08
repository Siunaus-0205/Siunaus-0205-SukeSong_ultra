/**
 * 端口探测 / 打开页面（后端自用，不依赖 pages 目录）。
 *
 * 为什么不用 netstat 判断服务是否在跑：服务退出之后 netstat 有时仍会留一行
 * 「:43130 ... LISTENING」，按它判断会误以为服务还活着，于是只开浏览器不启动服务。
 * 直接 TCP 连一下才是真的。
 *
 * 用法：
 *   node scripts/port.mjs check 43130
 *   node scripts/port.mjs open 43130 /review --token-file data\token.txt
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";

const args = process.argv.slice(2);
const verb = args[0];
const port = Number(args[1]) || 43130;
const path = (args[2] || "/").startsWith("/") ? args[2] || "/" : `/${args[2]}`;
const tokenFlag = args.indexOf("--token-file");
const tokenFile = tokenFlag >= 0 ? args[tokenFlag + 1] : "";

function reachable() {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readToken() {
  if (!tokenFile) return "";
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

if (verb === "check") {
  process.exit((await reachable()) ? 0 : 1);
}

if (verb === "open") {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await reachable()) {
      // token 文件是服务启动时才写的，起来后再读，读不到就多试几秒
      let token = readToken();
      for (let i = 0; !token && tokenFile && i < 20; i += 1) {
        await sleep(250);
        token = readToken();
      }
      const url = `http://127.0.0.1:${port}${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      console.log(`  打开 ${url}`);
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      process.exit(0);
    }
    await sleep(150);
  }
  console.log(`  服务 45 秒内没起来，请手动打开 http://127.0.0.1:${port}${path}`);
  process.exit(1);
}

console.log("用法: node scripts/port.mjs check <端口> | open <端口> [路径] [--token-file 文件]");
process.exit(2);
