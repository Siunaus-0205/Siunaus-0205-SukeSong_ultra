/**
 * 联网 AI 配置读取（第一 / 第二页）
 *
 * 配置文件只有一份，放在整合包根目录：
 *   atlas/ai-config.env      ← 第一页、第二页、backend 都读它
 * 改完保存即刻生效：本服务每次调用都重新读文件，不需要重启、不需要改代码。
 *
 * 取值优先级（前者覆盖后者）：
 *   根目录 ai-config.env  >  pages/ai-config.env（旧位置，兼容用）
 *                         >  pages/.env（旧位置，兼容用）
 *                         >  进程环境变量  >  内置默认值
 *
 * 兼容旧包：老版本把配置放在 pages/ 下，这里仍然会读，只是优先级更低；
 * 新装的包只认根目录那一份，两处同时存在也不会打架。
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** pages/ 目录（本文件在 pages/lib/ 下） */
export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** 整合包根目录 atlas/：配置文件、两个子服务都挂在这一层 */
export const ATLAS_ROOT = resolve(PROJECT_ROOT, "..");

/** 唯一生效位置 */
export const DEFAULT_CONFIG_PATH = resolve(ATLAS_ROOT, "ai-config.env");
/** 旧位置，按优先级从高到低；只在前面的文件不存在时才生效 */
export const LEGACY_CONFIG_PATHS = [
  resolve(PROJECT_ROOT, "ai-config.env"),
  resolve(PROJECT_ROOT, ".env"),
];

/** 每个配置项接受的文件键名（大小写不敏感，按顺序匹配） */
const KEYS = {
  apiKey: ["AI_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "API_KEY", "AI_KEY", "OPENAI_KEY"],
  baseURL: ["AI_BASE_URL", "AI_URL", "BASE_URL", "OPENAI_BASE_URL", "API_BASE_URL", "API_URL", "AI_ENDPOINT", "URL", "ENDPOINT"],
  model: ["AI_MODEL", "MODEL", "OPENAI_MODEL"],
  providerName: ["AI_PROVIDER_NAME", "PROVIDER_NAME", "PROVIDER"],
  mock: ["AI_MOCK"],
  timeoutMs: ["AI_TIMEOUT_MS"],
  temperature: ["AI_TEMPERATURE"],
};

function parseEnvSource(source) {
  const values = {};
  const text = String(source ?? "").replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("//")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toUpperCase();
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // 未加引号时，行内的 " # 注释" 一并去掉
      const commentAt = value.search(/\s[#;]/);
      if (commentAt > 0) value = value.slice(0, commentAt);
    }
    values[key] = value.trim();
  }
  return values;
}

function readConfigFile(path) {
  try {
    const stats = statSync(path);
    return {
      path,
      exists: true,
      values: parseEnvSource(readFileSync(path, "utf8")),
      mtimeMs: stats.mtimeMs,
      updatedAt: new Date(stats.mtimeMs).toISOString(),
      error: null,
    };
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    return {
      path,
      exists: false,
      values: {},
      mtimeMs: 0,
      updatedAt: null,
      error: missing ? null : `读取配置失败：${error?.message ?? error}`,
    };
  }
}

/** 生效的配置文件：默认根目录那份；AI_CONFIG_FILE 可临时指向别处（测试用） */
export function resolveConfigPath() {
  const override = String(process.env.AI_CONFIG_FILE ?? "").trim();
  if (!override) return DEFAULT_CONFIG_PATH;
  return isAbsolute(override) ? override : resolve(ATLAS_ROOT, override);
}

/** 相对根目录的短路径，写进日志与提示里；根目录之外的文件只留文件名 */
function shortPath(path) {
  const rel = relative(ATLAS_ROOT, path).replace(/\\/g, "/");
  if (rel.startsWith("..")) return path.split(/[\\/]/).pop() ?? rel;
  return rel;
}

/**
 * 读取当前生效的配置。
 * values 中保留"显式写空"的键（例如 AI_API_KEY=），语义是"用户主动清空"。
 */
export function readAiConfig() {
  const primary = readConfigFile(resolveConfigPath());
  const legacyFiles = LEGACY_CONFIG_PATHS.filter((path) => path !== primary.path).map(readConfigFile);

  // 低优先级先铺，高优先级后盖
  const values = {};
  for (const file of [...legacyFiles].reverse()) {
    if (file.exists) Object.assign(values, file.values);
  }
  Object.assign(values, primary.values);

  const active = primary.exists ? primary : legacyFiles.find((file) => file.exists) ?? null;
  const errorOf = [primary, ...legacyFiles].find((file) => file.error);

  return {
    primary,
    legacy: legacyFiles,
    values,
    file: shortPath(primary.path),
    activePath: active?.path ?? primary.path,
    activeFile: active ? shortPath(active.path) : null,
    updatedAt: active?.updatedAt ?? null,
    readError: errorOf?.error ?? null,
  };
}

/** 从已合并的配置里取值：文件里出现过（含空值）就以文件为准，否则回退到环境变量 */
export function getSettingEntry(name) {
  const keys = KEYS[name];
  if (!keys) throw new Error(`Unknown AI setting: ${name}`);
  const merged = readAiConfig();
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(merged.values, key)) {
      return { key, value: merged.values[key], source: "file", file: merged.activeFile };
    }
  }
  for (const key of keys) {
    if (process.env[key] !== undefined) {
      return { key, value: String(process.env[key]), source: "env", file: null };
    }
  }
  return null;
}

export function getSetting(name) {
  return getSettingEntry(name)?.value;
}

/**
 * 归一化 AI 端点：补协议、去掉末尾斜杠、去掉误粘贴的 /chat/completions。
 * 返回 { url, host, error }；空输入返回 url=""（由调用方套默认值）。
 */
export function normalizeBaseURL(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return { url: "", host: "", error: null };
  value = value.replace(/\s+/g, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { url: "", host: "", error: "AI_BASE_URL 不是合法的 URL。" };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { url: "", host: "", error: "AI_BASE_URL 只支持 http / https。" };
  }
  if (!parsed.hostname) {
    return { url: "", host: "", error: "AI_BASE_URL 缺少域名。" };
  }

  let pathname = parsed.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/chat\/completions$/i, "");
  return { url: `${parsed.origin}${pathname}`, host: parsed.host, error: null };
}

/** 端点 → 可读的来源名，用于右上角徽标 */
export function providerLabelFor(baseURL, explicit) {
  const custom = String(explicit ?? "").trim();
  if (custom) return custom.slice(0, 32);

  let host = "";
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return "Custom API";
  }
  if (!host) return "Custom API";
  if (host.endsWith("deepseek.com")) return "DeepSeek";
  if (host.endsWith("openai.com")) return "OpenAI";
  if (host.includes("moonshot") || host.includes("kimi")) return "Kimi / Moonshot";
  if (host.includes("dashscope") || host.includes("aliyuncs")) return "通义千问";
  if (host.includes("volces") || host.includes("volcengine")) return "火山方舟";
  if (host.includes("siliconflow")) return "SiliconFlow";
  if (host.includes("zhipu") || host.includes("bigmodel")) return "智谱";
  if (host.includes("baichuan")) return "百川";
  if (host.includes("minimax")) return "MiniMax";
  if (host.includes("localhost") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return "Local API";
  }
  return host;
}

/** 没填模型时按端点猜一个常见默认值 */
export function defaultModelFor(baseURL) {
  let host = "";
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return "gpt-4o-mini";
  }
  if (host.includes("deepseek")) return "deepseek-chat";
  if (host.includes("moonshot") || host.includes("kimi")) return "moonshot-v1-8k";
  if (host.includes("dashscope") || host.includes("aliyuncs")) return "qwen-plus";
  return "gpt-4o-mini";
}
