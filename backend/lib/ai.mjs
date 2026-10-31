/**
 * 联网 AI 客户端（只做一件事：按工具契约拿一次函数调用）。
 *
 * 与第一页共用同一份 ai-config.env，但本服务不依赖第一 / 第二页的代码，
 * 可以单独打包运行。
 */

import { readFileSync, statSync } from "node:fs";

import { validate } from "./schema.mjs";

const KEY_ALIASES = {
  apiKey: ["AI_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "API_KEY"],
  baseURL: ["AI_BASE_URL", "AI_URL", "BASE_URL", "OPENAI_BASE_URL"],
  model: ["AI_MODEL", "MODEL", "OPENAI_MODEL"],
  providerName: ["AI_PROVIDER_NAME", "PROVIDER_NAME"],
  mock: ["AI_MOCK"],
  timeoutMs: ["AI_TIMEOUT_MS"],
  temperature: ["AI_TEMPERATURE"],
};

function parseEnvFile(path) {
  const values = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return values;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("//")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const commentAt = value.search(/\s[#;]/);
      if (commentAt > 0) value = value.slice(0, commentAt);
    }
    values[match[1].toUpperCase()] = value.trim();
  }
  return values;
}

function first(values, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
  }
  return "";
}

function defaultModel(baseURL) {
  try {
    const host = new URL(baseURL).hostname;
    if (host.includes("deepseek")) return "deepseek-chat";
    if (host.includes("moonshot")) return "moonshot-v1-8k";
    if (host.includes("dashscope")) return "qwen-plus";
  } catch {
    /* ignore */
  }
  return "gpt-4o-mini";
}

export function normalizeBaseURL(raw) {
  let value = String(raw || "").trim().replace(/\s+/g, "");
  if (!value) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  let pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
  return `${url.origin}${pathname}`;
}

export function loadAiSettings(configFile, timeoutMs, { forceMock = false } = {}) {
  const values = parseEnvFile(configFile);
  const apiKey = first(values, KEY_ALIASES.apiKey).trim();
  const baseURL = normalizeBaseURL(first(values, KEY_ALIASES.baseURL) || "https://api.deepseek.com");
  const model = first(values, KEY_ALIASES.model).trim() || defaultModel(baseURL);
  const providerName = first(values, KEY_ALIASES.providerName).trim() || "AI";
  const explicitMock = ["1", "true", "yes", "on"].includes(
    String(first(values, KEY_ALIASES.mock)).toLowerCase(),
  );
  const fileTimeout = Number(first(values, KEY_ALIASES.timeoutMs));
  const fileTemperature = Number(first(values, KEY_ALIASES.temperature));
  return {
    configFile,
    apiKey,
    baseURL,
    model,
    providerName,
    mock: forceMock || explicitMock || !apiKey,
    temperature: Number.isFinite(fileTemperature) && fileTemperature >= 0 ? fileTemperature : undefined,
    timeoutMs: Number.isFinite(fileTimeout) && fileTimeout > 0 ? fileTimeout : timeoutMs,
    updatedAt: statSafe(configFile),
  };
}

function statSafe(path) {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function chatURL(baseURL) {
  return /\/chat\/completions$/i.test(baseURL) ? baseURL : `${baseURL}/chat/completions`;
}

export class AiError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * 上游模型的「脾气」适配表。
 *
 * 不同推理模型对标准 chat/completions 参数有各自的限制，遇到 400 时
 * 与其让人去猜参数，不如按报错自动降一档重试一次：
 *   - 只接受 temperature=1（Kimi 编程模型）
 *   - 推理模式下不允许强制指定 tool_choice（Kimi K2 thinking）
 *   - 需要显式关掉思考，才肯走工具调用
 * 每条返回新 body，返回 null 表示「这条不适配，看下一条」。
 */
const PARAM_ADAPTORS = [
  (body, text) =>
    /temperature/i.test(text) && body.temperature !== undefined && body.temperature !== 1
      ? { ...body, temperature: 1 }
      : null,
  (body, text) =>
    /tool_choice/i.test(text) && body.tool_choice && body.tool_choice !== "required"
      ? { ...body, tool_choice: "required" }
      : null,
  (body, text) =>
    /tool_choice/i.test(text) && body.tool_choice && body.tool_choice !== "auto"
      ? { ...body, tool_choice: "auto" }
      : null,
  (body, text) =>
    /thinking|reasoning/i.test(text) && !body.thinking ? { ...body, thinking: { type: "disabled" } } : null,
];

async function post(settings, body) {
  let payload = body;
  for (let attempt = 1; attempt <= PARAM_ADAPTORS.length + 1; attempt += 1) {
    let response;
    try {
      response = await fetch(chatURL(settings.baseURL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
    } catch (error) {
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new AiError(timeout ? "AI_TIMEOUT" : "AI_NETWORK", `AI 请求失败：${error.message}`, {
        retryable: true,
      });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 400) {
        let adapted = null;
        for (const adaptor of PARAM_ADAPTORS) {
          adapted = adaptor(payload, text);
          if (adapted) break;
        }
        if (adapted) {
          payload = adapted;
          continue;
        }
      }
      throw new AiError(
        response.status === 401 || response.status === 403 ? "AI_AUTH" : "AI_UPSTREAM",
        `AI 服务 HTTP ${response.status}：${text.slice(0, 300)}`,
        { retryable: response.status === 429 || response.status >= 500 },
      );
    }
    return response.json();
  }
  throw new AiError("AI_UPSTREAM", "AI 服务请求失败（参数适配重试后仍失败）");
}

/**
 * 请求一次工具调用，并按 schema 校验。
 * 校验失败会自动纠错重试一次；仍失败则抛错（该商品进入人工审核）。
 */
export async function requestTool({ settings, tool, messages, temperature }) {
  if (temperature === undefined) temperature = Number.isFinite(settings?.temperature) ? settings.temperature : 0.1;
  const conversation = [...messages];
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const data = await post(settings, {
      model: settings.model,
      messages: conversation,
      tools: [tool],
      tool_choice: { type: "function", function: { name: tool.function.name } },
      temperature,
      max_tokens: 2048,
    });
    const message = data?.choices?.[0]?.message || {};
    const call = (message.tool_calls || [])[0];
    if (!call) {
      lastError = new AiError("AI_NO_TOOL", "AI 没有调用指定函数。", { retryable: true });
      if (attempt === 1) {
        // 上游不接受空的 assistant 消息（Kimi 会回 400 "must not be empty"），
        // 所以模型没吐内容时补一句占位，别把空串塞回去。
        const said = String(message.content || "").trim();
        conversation.push(
          { role: "assistant", content: said || "（未输出内容，改为直接调用函数）" },
          { role: "user", content: `请调用函数 ${tool.function.name}，只输出函数调用。` },
        );
        continue;
      }
      throw lastError;
    }
    let args;
    try {
      args =
        typeof call.function.arguments === "string"
          ? JSON.parse(call.function.arguments)
          : call.function.arguments;
      validate(tool.function.parameters, args);
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        conversation.push(
          { role: "assistant", content: message.content || "" },
          {
            role: "user",
            content: `上一次函数参数不合法：${error.message}。请重新调用 ${tool.function.name}，严格满足 Schema。`,
          },
        );
        continue;
      }
      throw new AiError("AI_BAD_ARGS", `AI 函数参数不合法：${error.message}`);
    }
    return { args, usage: data.usage || null, model: data.model || settings.model, content: message.content || "" };
  }

  throw lastError;
}
