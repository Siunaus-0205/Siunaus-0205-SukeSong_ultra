/**
 * 进程日志：内存环形缓冲 + 追加文件，供"后端检查页"实时查看。
 */

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_ENTRIES = 1000;

let seq = 0;
let startedAt = new Date().toISOString();
const entries = [];
let logFile = null;

function appendToFile(entry) {
  if (!logFile) return;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function initLog(config) {
  logFile = join(config.dataDir, "logs", "server.log");
  startedAt = new Date().toISOString();
  entries.length = 0;
  seq = 0;
}

export function log(level, message, meta = null) {
  const entry = {
    id: ++seq,
    at: new Date().toISOString(),
    level,
    message: String(message),
    meta: meta || undefined,
  };
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();
  appendToFile(entry);
  const stream = level === "error" ? console.error : console.log;
  const localTime = new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false });
  stream(`[${localTime}] ${message}`);
  return entry;
}

export function tail(limit = 200, since = 0) {
  const size = Math.max(1, Math.min(1000, Number(limit) || 200));
  const filtered = since ? entries.filter((entry) => entry.id > Number(since)) : entries;
  return {
    startedAt,
    latestId: seq,
    entries: filtered.slice(-size),
  };
}

export function logFileInfo() {
  if (!logFile) return null;
  try {
    const stats = statSync(logFile);
    return { path: logFile, bytes: stats.size, updatedAt: new Date(stats.mtimeMs).toISOString() };
  } catch {
    return { path: logFile, bytes: 0, updatedAt: null };
  }
}
