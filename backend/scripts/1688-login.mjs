#!/usr/bin/env node
/**
 * 1688-login.mjs — 用一个专用浏览器配置登录 1688，并把 Cookie 提取到 data/1688-cookie.txt
 *
 * 为什么不直接扒日常浏览器的 Cookie：
 *   - Chromium 运行时对 Cookies 库加独占锁，外部读不到；
 *   - Cookie 值 v20（App-Bound）加密，密钥绑定「可执行文件 + 用户数据目录路径」，
 *     复制/junction 到别的路径都会解不开，浏览器还会把解不开的 Cookie 当损坏删掉；
 *   - Chrome/Edge 对「默认用户数据目录」直接禁用 --remote-debugging-port。
 *
 * 所以这里用一个**非默认路径**的专用配置（默认 backend/data/1688-profile）：
 *   - 路径不是默认目录 → CDP 可用；
 *   - 路径固定不变 → App-Bound 密钥一直有效；
 *   - 你只在这个窗口里扫码登录一次，之后脚本随时能取出新的 Cookie；
 *   - 完全不碰你日常在用的 Edge/Chrome 配置。
 *
 * 用法：
 *   node scripts/1688-login.mjs                  # 打开窗口等你扫码，登录成功自动存 Cookie
 *   node scripts/1688-login.mjs --grab-only      # 不登录，直接从已有配置里刷新 Cookie
 *   node scripts/1688-login.mjs --keep           # 登录后不关窗口
 *   node scripts/1688-login.mjs --browser=edge
 *   node scripts/1688-login.mjs --timeout=600    # 等待秒数
 *
 * 退出码：0 成功 / 3 超时未登录 / 1 其他
 *
 * 注意：只打印 Cookie 名字和长度，不打印值。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(HERE, "..");
const LOGIN_URL = "https://login.1688.com/member/signin.htm?done=https%3A%2F%2Fwww.1688.com%2F";
const HOME_URL = "https://www.1688.com/";

/* ---------------------------------------------------------------- 参数 */

const argv = process.argv.slice(2);
const opt = {
  browser: "chrome",
  keep: false,
  grabOnly: false,
  timeout: 600,
  port: 0,
  profileDir: path.join(BACKEND_DIR, "data", "1688-profile"),
  out: path.join(BACKEND_DIR, "data", "1688-cookie.txt"),
};
for (const a of argv) {
  if (a === "--keep") opt.keep = true;
  else if (a === "--grab-only") opt.grabOnly = true;
  else if (a.startsWith("--browser=")) opt.browser = a.slice(10).trim().toLowerCase();
  else if (a.startsWith("--timeout=")) opt.timeout = Math.max(30, Number(a.slice(10)) || 600);
  else if (a.startsWith("--port=")) opt.port = Number(a.slice(7)) || 0;
  else if (a.startsWith("--profile-dir=")) opt.profileDir = path.resolve(a.slice(14).replace(/^"|"$/g, ""));
  else if (a.startsWith("--out=")) opt.out = path.resolve(a.slice(6).replace(/^"|"$/g, ""));
  else if (a === "-h" || a === "--help") {
    console.log(
      [
        "node scripts/1688-login.mjs [选项]",
        "  --grab-only        不登录，只从已有配置刷新 Cookie",
        "  --keep             抓完不关浏览器窗口",
        "  --browser=chrome|edge",
        "  --timeout=<秒>     等待扫码的时间（默认 600）",
        "  --profile-dir=<路径>  专用配置目录（默认 backend/data/1688-profile）",
        "  --out=<路径>       Cookie 输出文件（默认 backend/data/1688-cookie.txt）",
      ].join("\n")
    );
    process.exit(0);
  }
}

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const EXES = {
  chrome: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(LOCAL, "Google", "Chrome", "Application", "chrome.exe"),
  ],
  edge: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

const exe = (EXES[opt.browser] || EXES.chrome).find((p) => fs.existsSync(p));
if (!exe) {
  console.error(`找不到 ${opt.browser} 的可执行文件`);
  process.exit(1);
}

/* ---------------------------------------------------------------- 工具 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function httpJson(url, timeoutMs = 1500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function cdpCall(wsUrl, method, params = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let done = false;
    let ws;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws && ws.close();
      } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`${method} 超时`)), timeoutMs);
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      return finish(e);
    }
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.id !== 1) return;
      if (m.error) finish(new Error(m.error.message || JSON.stringify(m.error)));
      else finish(null, m.result);
    });
    ws.addEventListener("error", () => finish(new Error("CDP 连接失败")));
    ws.addEventListener("close", () => finish(new Error("CDP 连接被关闭")));
  });
}

async function getPageTarget(port) {
  const list = (await httpJson(`http://127.0.0.1:${port}/json/list`)) || [];
  return list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
}

async function getCookies(port) {
  const page = await getPageTarget(port);
  if (!page) return null;
  const res = await cdpCall(page.webSocketDebuggerUrl, "Storage.getCookies", {});
  return res && res.cookies ? res.cookies : [];
}

/**
 * 登录后光有 cookie2/unb 还不够：cna 和 _m_h5_tk 是页面 JS 在 1688 域下发的，
 * 少了它们风控更严。这里把页面带到 1688 首页停几秒，把它们补齐。
 */
async function settleCookies(port, want = ["cna", "_m_h5_tk"], maxMs = 9000) {
  const page = await getPageTarget(port);
  if (!page) return;
  try {
    await cdpCall(page.webSocketDebuggerUrl, "Page.navigate", { url: HOME_URL });
  } catch {
    return;
  }
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(1200);
    try {
      const map = pick1688((await getCookies(port)) || []);
      if (want.every((k) => map.has(k) && String(map.get(k).value || ""))) return;
    } catch {
      return;
    }
  }
}

/* ---------------------------------------------------------------- 登录态判定 */

const KEY_ORDER = ["cookie2", "_tb_token_", "t", "cna", "_m_h5_tk", "sgcookie", "__cn_logon__", "csg", "xlly_s", "unb"];

function pick1688(cookies) {
  const map = new Map();
  for (const c of cookies) {
    const d = String(c.domain || "").replace(/^\./, "").toLowerCase();
    if (d === "1688.com" || d.endsWith(".1688.com")) {
      if (!map.has(c.name) || !map.get(c.name).value) map.set(c.name, c);
    }
  }
  return map;
}

function orderedString(map) {
  const rank = (n) => {
    const i = KEY_ORDER.indexOf(n);
    return i === -1 ? KEY_ORDER.length : i;
  };
  return [...map.values()]
    .filter((c) => c && c.name && String(c.value ?? "") !== "")
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** cookie2 有值 + 有登录标识 = 已登录 */
function loginState(map) {
  const ck = map.get("cookie2");
  const logon = map.get("__cn_logon__");
  const unb = map.get("unb");
  const hasCookie2 = !!(ck && String(ck.value || "").length > 8);
  const logonTrue = !!(logon && String(logon.value).toLowerCase() === "true");
  return { hasCookie2, logonTrue, hasUnb: !!(unb && unb.value), ok: hasCookie2 && (logonTrue || (unb && unb.value)) };
}

/* ---------------------------------------------------------------- 主流程 */

const child = { proc: null };

function shutdown(code) {
  try {
    if (child.proc && !child.proc.killed) child.proc.kill();
  } catch {}
  process.exitCode = code;
}

async function main() {
  const port = opt.port || (await freePort());
  fs.mkdirSync(opt.profileDir, { recursive: true });

  console.log(`浏览器   : ${path.basename(exe)}`);
  console.log(`专用配置 : ${opt.profileDir}`);
  console.log(`调试端口 : ${port}`);
  console.log(opt.grabOnly ? "模式     : 仅提取（不登录）" : "模式     : 等待扫码登录");

  const args = [
    `--user-data-dir=${opt.profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-features=Translate,MediaRouter",
    "--window-size=1280,900",
  ];
  if (opt.grabOnly) args.push("--headless=new", "--disable-gpu", "about:blank");
  else args.push(LOGIN_URL);

  child.proc = spawn(exe, args, { stdio: "ignore", windowsHide: false });
  child.proc.unref();

  // 等调试端口
  const startDeadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < startDeadline) {
    if (await httpJson(`http://127.0.0.1:${port}/json/version`)) {
      ready = true;
      break;
    }
    if (child.proc.exitCode !== null) break;
    await sleep(300);
  }
  if (!ready) {
    console.error("✗ 浏览器没起来（调试端口没开）。可能被安全软件拦了。");
    return shutdown(1);
  }

  if (opt.grabOnly) {
    await sleep(1500);
    let map = pick1688((await getCookies(port)) || []);
    if (!map.size) {
      console.error("✗ 这个配置里没有 1688 Cookie，先跑一次正式登录。");
      return shutdown(3);
    }
    await settleCookies(port);
    map = pick1688((await getCookies(port)) || []);
    const st = loginState(map);
    const header = orderedString(map);
    fs.mkdirSync(path.dirname(opt.out), { recursive: true });
    fs.writeFileSync(opt.out, `${header}\r\n`, "utf8");
    console.log(`✓ 已刷新 ${opt.out}（${map.size} 个 Cookie，${header.length} 字符）`);
    console.log(`  登录态: cookie2=${st.hasCookie2 ? "有" : "无"} __cn_logon__=${st.logonTrue ? "true" : "无"}`);
    console.log(`  关键字段：${["cookie2", "_tb_token_", "cna", "_m_h5_tk", "__cn_logon__", "unb"].map((k) => `${k}=${map.has(k) ? "有" : "无"}`).join("  ")}`);
    return shutdown(st.ok ? 0 : 4);
  }

  console.log("\n请在打开的窗口里用 1688 App / 淘宝 App 扫码登录（扫码后会自动继续）…");
  const deadline = Date.now() + opt.timeout * 1000;
  let last = "";
  while (Date.now() < deadline) {
    await sleep(3000);
    let cookies;
    try {
      cookies = await getCookies(port);
    } catch {
      cookies = null;
    }
    if (cookies === null) {
      console.error("\n✗ 浏览器窗口被关闭或调试端口断了");
      return shutdown(1);
    }
    const map = pick1688(cookies);
    const st = loginState(map);
    const now = `cookie2=${st.hasCookie2 ? "有" : "无"} logon=${st.logonTrue ? "true" : "-"} 1688cookie=${map.size}`;
    if (now !== last) {
      console.log(`  [${new Date().toLocaleTimeString()}] ${now}`);
      last = now;
    }
    if (st.ok) {
      console.log("  登录成功，补齐 cna / _m_h5_tk …");
      await settleCookies(port);
      const full = pick1688((await getCookies(port)) || []);
      const header = orderedString(full);
      fs.mkdirSync(path.dirname(opt.out), { recursive: true });
      fs.writeFileSync(opt.out, `${header}\r\n`, "utf8");
      console.log(`\n✓ 登录成功，已写入 ${opt.out}`);
      console.log(`  ${full.size} 个 1688 Cookie，${header.length} 字符`);
      console.log(`  关键字段：${["cookie2", "_tb_token_", "cna", "_m_h5_tk", "__cn_logon__", "unb"].map((k) => `${k}=${full.has(k) ? "有" : "无"}`).join("  ")}`);
      if (!opt.keep) {
        await sleep(800);
        try {
          child.proc.kill();
        } catch {}
      }
      console.log("\n下一步: node scripts/check-1688.mjs");
      return shutdown(0);
    }
  }
  console.error(`\n✗ 等 ${opt.timeout} 秒没等到登录完成`);
  return shutdown(3);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

main();
