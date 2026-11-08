/**
 * 端口探测 / 打开页面。
 *
 * 为什么不用 netstat 判断服务是否在跑：这台机器上 netstat 在服务退出之后仍会留一行
 * 「:43125 ... LISTENING 0」，按它判断会误以为服务还活着，于是只打开浏览器、不启动服务，
 * 浏览器就连上了一个没有人的端口。直接 TCP 连一下才是真的。
 *
 * 用法：
 *   node scripts/port.mjs check 43125        连得上退出 0，连不上退出 1
 *   node scripts/port.mjs open 43125 [/path] 等服务真的就绪后再打开默认浏览器（最多等 45 秒）
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";

const [verb, portArg, path = "/"] = process.argv.slice(2);
const port = Number(portArg) || 43125;
const url = `http://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`;

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

if (verb === "check") {
  process.exit((await reachable()) ? 0 : 1);
}

if (verb === "open") {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await reachable()) {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      process.exit(0);
    }
    await sleep(150);
  }
  console.log(`  服务 45 秒内没起来，请手动打开 ${url}`);
  process.exit(1);
}

console.log("用法: node scripts/port.mjs check <端口> | open <端口> [路径]");
process.exit(2);
