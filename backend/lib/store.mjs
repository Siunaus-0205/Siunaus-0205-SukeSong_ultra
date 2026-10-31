/**
 * 文件存储：所有 JSON 都是"原子写"，避免中途失败留下半个文件。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(path, value) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

export function appendJsonl(path, record) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

export function timestampId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

export function runDir(config, runId) {
  const dir = join(config.runsDir, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runFile(config, runId, name) {
  return join(runDir(config, runId), name);
}

export function updateState(config, patch) {
  const current = readJson(config.stateFile, {}) || {};
  const next = { ...current, ...patch };
  writeJsonAtomic(config.stateFile, next);
  return next;
}
