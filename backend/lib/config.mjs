/**
 * 配置加载：market-config.env + 环境变量。
 *
 * 这个服务刻意与第一 / 第二页分开：
 *   - 只监听 127.0.0.1，默认端口 43130；
 *   - 所有 /api 请求都必须带 token；
 *   - 第一 / 第二页的前端不引用本服务的任何地址。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROJECT_DIR = resolve(APP_DIR, "..");
/** 整合后的目录：atlas/pages（第一 / 第二页） + atlas/backend（本服务）。 */
export const PAGES_DIR = join(PROJECT_DIR, "pages");

const DEFAULTS = {
  MARKET_HOST: "127.0.0.1",
  MARKET_PORT: "43130",
  MARKET_PLATFORM: "mock",
  MARKET_DAILY_AT: "08:00",
  MARKET_TIMEZONE: "Asia/Shanghai",
  MARKET_SCHEDULE_ENABLED: "0",
  MARKET_RUN_ON_START: "0",
  MARKET_SALES_RANK: "10",
  MARKET_SALES_RATIO: "0.7",
  MARKET_OUTLIER_RATIO: "0.4",
  MARKET_OUTLIER_ROUNDS: "3",
  MARKET_SAME_PRICE_TOLERANCE: "0.3",
  MARKET_MIN_CONFIDENCE: "0.6",
  MARKET_MAX_RESULTS: "60",
  MARKET_DETAIL_CONCURRENCY: "2",
  MARKET_1688_COOKIE: "",
  MARKET_1688_COOKIE_FILE: "",
  MARKET_1688_DELAY_MS: "3500",
  MARKET_1688_SEARCH_LIMIT: "4",
  MARKET_1688_SEEDS_FILE: "",
  MARKET_1688_DIRECT: "1",
  MARKET_AI_TIMEOUT_MS: "90000",
  MARKET_AI_MOCK: "0",
  MARKET_APP_URL: "http://127.0.0.1:43125",
  MARKET_ALLOW_SIMULATED_WRITE: "0",
  MARKET_PARTS_FILE: join(PAGES_DIR, "public", "data", "h3-parts.json"),
  MARKET_TABLE1_FILE: join(PAGES_DIR, "presets", "table1.json"),
  // 与第一 / 第二页共用根目录那一份配置，见「AI 配置只有一份」
  MARKET_AI_CONFIG_FILE: join(PROJECT_DIR, "ai-config.env"),
  MARKET_DATA_DIR: join(APP_DIR, "data"),
};

function parseEnvFile(path) {
  const result = {};
  if (!existsSync(path)) return result;
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function flag(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

/**
 * AI 配置文件解析：默认根目录 atlas/ai-config.env。
 * 兼容旧包：根目录那份不存在时，退回 backend/ai-config.env、pages/ai-config.env，
 * 这样升级包时不用改任何东西，两处同时存在时以根目录为准。
 */
function pickAiConfigFile(raw) {
  const primary = resolve(raw);
  if (existsSync(primary)) return primary;
  for (const legacy of [join(APP_DIR, "ai-config.env"), join(PAGES_DIR, "ai-config.env")]) {
    if (existsSync(legacy)) return legacy;
  }
  return primary;
}

function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ensureToken(dataDir, explicit) {
  if (explicit && explicit.trim()) return explicit.trim();
  const tokenFile = join(dataDir, "token.txt");
  if (existsSync(tokenFile)) {
    const saved = readFileSync(tokenFile, "utf8").trim();
    if (saved) return saved;
  }
  const token = randomBytes(16).toString("hex");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, "utf8");
  return token;
}

export function loadConfig(overrides = {}) {
  const envFile = overrides.envFile || process.env.MARKET_CONFIG_FILE || join(APP_DIR, "market-config.env");
  const fileValues = parseEnvFile(envFile);
  const values = { ...DEFAULTS, ...fileValues };
  for (const key of Object.keys(DEFAULTS)) {
    if (overrides[key] !== undefined) values[key] = overrides[key];
    else if (process.env[key] !== undefined && process.env[key] !== "") values[key] = process.env[key];
  }

  const dataDir = resolve(values.MARKET_DATA_DIR);
  mkdirSync(dataDir, { recursive: true });

  const partsFile = resolve(values.MARKET_PARTS_FILE);
  const platform = String(values.MARKET_PLATFORM || "mock").trim().toLowerCase();
  const simulated = platform === "mock";

  // 1688 的 Cookie 很长，允许放在单独文件里，免得把 market-config.env 写成一行巨长
  const cookieFile = values.MARKET_1688_COOKIE_FILE
    ? resolve(values.MARKET_1688_COOKIE_FILE)
    : join(dataDir, "1688-cookie.txt");
  let cookie1688 = String(values.MARKET_1688_COOKIE || "").trim();
  if (!cookie1688 && existsSync(cookieFile)) {
    cookie1688 = readFileSync(cookieFile, "utf8").replace(/^\uFEFF/, "").trim();
  }

  return {
    envFile,
    host: String(values.MARKET_HOST || "127.0.0.1"),
    port: numberValue(values.MARKET_PORT, 43130),
    token: ensureToken(dataDir, values.MARKET_TOKEN),
    platform,
    simulated,
    dailyAt: String(values.MARKET_DAILY_AT || "08:00"),
    timeZone: String(values.MARKET_TIMEZONE || "Asia/Shanghai"),
    scheduleEnabled: flag(values.MARKET_SCHEDULE_ENABLED),
    runOnStart: flag(values.MARKET_RUN_ON_START),
    rank: Math.max(1, Math.round(numberValue(values.MARKET_SALES_RANK, 10))),
    salesRatio: numberValue(values.MARKET_SALES_RATIO, 0.7),
    outlierRatio: numberValue(values.MARKET_OUTLIER_RATIO, 0.4),
    outlierRounds: Math.max(1, Math.round(numberValue(values.MARKET_OUTLIER_ROUNDS, 3))),
    samePriceTolerance: numberValue(values.MARKET_SAME_PRICE_TOLERANCE, 0.3),
    minConfidence: numberValue(values.MARKET_MIN_CONFIDENCE, 0.6),
    maxResults: Math.max(1, Math.round(numberValue(values.MARKET_MAX_RESULTS, 60))),
    detailConcurrency: Math.max(1, Math.round(numberValue(values.MARKET_DETAIL_CONCURRENCY, 2))),
    cookie1688,
    cookie1688File: cookieFile,
    delay1688Ms: Math.max(500, Math.round(numberValue(values.MARKET_1688_DELAY_MS, 3500))),
    limit1688: Math.max(1, Math.round(numberValue(values.MARKET_1688_SEARCH_LIMIT, 4))),
    seeds1688File: values.MARKET_1688_SEEDS_FILE
      ? resolve(values.MARKET_1688_SEEDS_FILE)
      : join(APP_DIR, "seeds", "1688-seeds.json"),
    direct1688: flag(values.MARKET_1688_DIRECT),
    aiTimeoutMs: Math.max(1000, Math.round(numberValue(values.MARKET_AI_TIMEOUT_MS, 90_000))),
    aiMock: flag(values.MARKET_AI_MOCK),
    appUrl: String(values.MARKET_APP_URL || "http://127.0.0.1:43125").replace(/\/+$/, ""),
    allowSimulatedWrite: flag(values.MARKET_ALLOW_SIMULATED_WRITE),
    partsFile,
    table1File: resolve(values.MARKET_TABLE1_FILE),
    aiConfigFile: pickAiConfigFile(values.MARKET_AI_CONFIG_FILE),
    dataDir,
    backupsDir: join(dataDir, "backups"),
    runsDir: join(dataDir, "runs"),
    reviewFile: join(dataDir, "review-queue.json"),
    stateFile: join(dataDir, "state.json"),
    lockFile: join(dataDir, "run.lock"),
    logFile: join(dataDir, "logs", "server.log"),
    tempFile: join(dataDir, "temp", "latest.json"),
    platformTag: platform === "mock" ? "模拟数据" : platform === "1688" ? "1688 实时抓取" : platform,
  };
}
