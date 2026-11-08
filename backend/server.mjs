/**
 * 市场零件后端（独立服务）。
 *
 * 设计边界：
 *   - 只监听 127.0.0.1，独立端口 43130；
 *   - 第一 / 第二页的前端不引用这里的任何地址，也没有任何反向代理；
 *   - 所有接口都要 token（URL 参数或 x-market-token 头）；
 *   - 审核页也是本服务自己提供的，与页面一 / 二无关。
 */

import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

import { APP_DIR, loadConfig } from "./lib/config.mjs";
import { loadAiSettings } from "./lib/ai.mjs";
import { createFunctionLayer } from "./lib/functions.mjs";
import { mergeLinks, normalizeLinks } from "./lib/links.mjs";
import { initLog, log, logFileInfo, tail } from "./lib/logbus.mjs";
import { indexParts, loadParts, loadTable1 } from "./lib/parts.mjs";
import { runPipeline } from "./lib/pipeline.mjs";
import { startScheduler } from "./lib/scheduler.mjs";
import { readJson, updateState, writeJsonAtomic } from "./lib/store.mjs";

const VERSION = "3.3.0";
const config = loadConfig();

/**
 * 每次调用都重读根目录 atlas/ai-config.env。
 * 这样改配置后后端不用重启：下一次抓取、下一次查 /api/status 就是新配置。
 */
function refreshAiSettings() {
  config.aiSettings = loadAiSettings(config.aiConfigFile, config.aiTimeoutMs, {
    forceMock: config.aiMock,
  });
  return config.aiSettings;
}

const bootAi = refreshAiSettings();
initLog(config);
const startedAt = new Date().toISOString();

let currentRun = null;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(payload);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function tokenFrom(req, url) {
  return String(url.searchParams.get("token") || req.headers["x-market-token"] || "");
}

function tokenOk(req, url) {
  const provided = Buffer.from(tokenFrom(req, url));
  const expected = Buffer.from(config.token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function pendingCount() {
  const queue = readJson(config.reviewFile, { items: [] }) || { items: [] };
  return (queue.items || []).filter((item) => item.status === "pending").length;
}

function safeRunId(value) {
  const id = String(value || "");
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
}

function listRuns() {
  const runs = [];
  try {
    for (const name of readdirSync(config.runsDir)) {
      const meta = readJson(join(config.runsDir, name, "meta.json"), null);
      if (meta) runs.push(meta);
    }
  } catch {
    /* ignore */
  }
  return runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function startRun({ trigger, partTypeCodes, dryRun }) {
  if (currentRun) throw new Error("已有一次抓取在运行。");
  const runId = `${new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  currentRun = { runId, trigger, startedAt: new Date().toISOString() };
  log("info", `抓取开始 · ${trigger} · ${runId}${dryRun ? " · dry-run" : ""}`, {
    runId,
    partTypeCodes: partTypeCodes || "all",
  });
  const promise = runPipeline(config, { trigger, runId, partTypeCodes, dryRun })
    .then((summary) => {
      currentRun = null;
      const skipped = summary.totals.skipped || 0;
      const skippedNote = skipped ? ` / 跳过 ${skipped} 类（没种子或没候选）` : "";
      log(
        "info",
        `抓取完成 · ${runId} · 新建 ${summary.totals.created} / 更新 ${summary.totals.updated} / 审核 ${summary.totals.reviewed}${skippedNote} / 用时 ${summary.durationMs}ms`,
        { runId, write: summary.write, skippedTypes: summary.skippedTypes || [] },
      );
      for (const item of summary.skippedTypes || []) {
        log("warn", `跳过 ${item.partTypeCode} ${item.partTypeName}：${item.reason}`, { runId });
      }
      return summary;
    })
    .catch((error) => {
      currentRun = null;
      updateState(config, { lastRunStatus: "failed", lastRunError: error.message });
      log("error", `抓取失败 · ${runId} · ${error.message}`, { runId });
      throw error;
    });
  return { runId, promise };
}

function serveHtml(res, file) {
  const html = readFileSync(join(APP_DIR, "public", file), "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  });
  res.end(html);
}

async function approveReview(itemId, body) {
  const queue = readJson(config.reviewFile, { items: [] }) || { items: [] };
  const item = (queue.items || []).find((row) => row.id === itemId);
  if (!item) return { status: 404, body: { error: "审核项不存在" } };
  if (item.status !== "pending") return { status: 409, body: { error: "该审核项已处理" } };

  const group = item.group || {};
  const parts = loadParts(config);
  const fn = createFunctionLayer(config, `review-${item.id}`, () => {});
  const price = Number(body.price ?? group.medianPrice);
  if (!Number.isFinite(price) || price <= 0) return { status: 400, body: { error: "价格不合法" } };

  // 链接规则：当前产品的主链接（true）保留，新抓的链接作为备选；总数 1 条 true + 最多 3 条 false。
  const currentVariant = item.match?.variantId
    ? indexParts(parts).variants.get(item.match.variantId)
    : null;
  const links = currentVariant
    ? mergeLinks(currentVariant.links, group.links)
    : normalizeLinks(group.links);

  if (item.match?.variantId) {
    fn.commitMarketPart(
      {
        action: "update",
        partTypeCode: item.partTypeCode,
        variantId: item.match.variantId,
        manufacturer: group.manufacturer,
        model: group.model,
        displayName: group.displayName,
        price,
        params: group.params,
        spec: group.spec,
        links,
        source: "人工审核",
      },
      parts,
    );
  } else {
    if (!group.codeSuffix) {
      return { status: 400, body: { error: "缺少第四段编号，无法创建新型号" } };
    }
    fn.commitMarketPart(
      {
        action: "create",
        partTypeCode: item.partTypeCode,
        codeSuffix: group.codeSuffix,
        manufacturer: group.manufacturer,
        model: group.model,
        displayName: group.displayName,
        price,
        params: group.params,
        spec: group.spec,
        links,
        source: "人工审核",
      },
      parts,
    );
  }
  fn.writePartsFile(parts);

  item.status = "approved";
  item.decidedAt = new Date().toISOString();
  item.decidedBy = "human";
  item.decidedPrice = price;
  item.linksAfter = links.length;
  writeJsonAtomic(config.reviewFile, queue);
  return { status: 200, body: { ok: true, item } };
}

function rejectReview(itemId, body) {
  const queue = readJson(config.reviewFile, { items: [] }) || { items: [] };
  const item = (queue.items || []).find((row) => row.id === itemId);
  if (!item) return { status: 404, body: { error: "审核项不存在" } };
  if (item.status !== "pending") return { status: 409, body: { error: "该审核项已处理" } };
  item.status = "rejected";
  item.decidedAt = new Date().toISOString();
  item.decidedBy = "human";
  item.note = String(body.note || "").slice(0, 300);
  writeJsonAtomic(config.reviewFile, queue);
  return { status: 200, body: { ok: true, item } };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const path = url.pathname;

  try {
    if (path === "/") {
      const token = url.searchParams.get("token");
      res.writeHead(302, { Location: token ? `/review?token=${encodeURIComponent(token)}` : "/review" });
      return res.end();
    }
    if (path === "/review" || path === "/run" || path === "/inspect") {
      const file = { "/review": "review.html", "/run": "run.html", "/inspect": "inspect.html" }[path];
      return serveHtml(res, file);
    }
    if (!path.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (!tokenOk(req, url)) return json(res, 401, { error: "token 无效" });

    if (req.method === "GET" && path === "/api/health") {
      return json(res, 200, {
        ok: true,
        name: "ATLAS Market Watch",
        version: VERSION,
        startedAt,
        tokenRequired: true,
      });
    }

    if (req.method === "GET" && path === "/api/status") {
      const state = readJson(config.stateFile, {}) || {};
      const ai = refreshAiSettings();
      return json(res, 200, {
        ok: true,
        version: VERSION,
        uptimeSec: Math.round((Date.now() - Date.parse(startedAt)) / 1000),
        platform: config.platform,
        platformTag: config.platformTag,
        simulated: config.simulated,
        schedule: {
          enabled: config.scheduleEnabled,
          dailyAt: config.dailyAt,
          timeZone: config.timeZone,
        },
        ai: { mode: ai.mock ? "mock" : "live", model: ai.model, configFile: ai.configFile },
        partsFile: config.partsFile,
        allowSimulatedWrite: config.allowSimulatedWrite,
        appUrl: config.appUrl,
        urls: {
          page1: `${config.appUrl}/`,
          page2: `${config.appUrl}/next.html`,
          review: `http://${config.host}:${config.port}/review`,
          run: `http://${config.host}:${config.port}/run`,
          inspect: `http://${config.host}:${config.port}/inspect`,
        },
        logFile: logFileInfo(),
        currentRun,
        lastRun: state.lastRun || null,
        lastRunStatus: state.lastRunStatus || null,
        lastRunError: state.lastRunError || null,
        pendingReviews: pendingCount(),
      });
    }

    if (req.method === "GET" && path === "/api/logs") {
      return json(res, 200, {
        ok: true,
        ...tail(url.searchParams.get("limit"), url.searchParams.get("since")),
      });
    }

    if (req.method === "GET" && path === "/api/part-types") {
      const table1 = loadTable1(config);
      return json(res, 200, {
        ok: true,
        productType: { id: table1.productType.id, name: table1.productType.name },
        partTypes: table1.partTypes.map((part) => ({
          code: part.code,
          name: part.name,
          moduleCode: part.moduleCode,
          moduleName: part.moduleName,
        })),
      });
    }

    if (req.method === "GET" && path === "/api/temp") {
      const requested = url.searchParams.get("runId");
      let runId = requested;
      let createdAt = null;
      let rows = [];
      if (!runId || runId === "latest") {
        const latest = readJson(config.tempFile, null);
        if (latest) {
          runId = latest.runId;
          createdAt = latest.createdAt;
          rows = Array.isArray(latest.rows) ? latest.rows : [];
        }
      } else {
        if (!safeRunId(runId)) return json(res, 400, { error: "runId 不合法" });
        const stored = readJson(join(config.runsDir, runId, "staging.json"), []);
        rows = Array.isArray(stored) ? stored : [];
      }
      const counts = rows.reduce((acc, row) => {
        acc[row.status || "unknown"] = (acc[row.status || "unknown"] || 0) + 1;
        return acc;
      }, {});
      const status = url.searchParams.get("status") || "";
      const partTypeCode = url.searchParams.get("partTypeCode") || "";
      const filtered = rows.filter(
        (row) =>
          (!status || row.status === status) &&
          (!partTypeCode || row.partTypeCode === partTypeCode),
      );
      const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit")) || 300));
      return json(res, 200, {
        ok: true,
        runId: runId || null,
        createdAt,
        counts,
        total: rows.length,
        filtered: filtered.length,
        rows: filtered.slice(0, limit),
      });
    }

    if (req.method === "GET" && path === "/api/review") {
      const queue = readJson(config.reviewFile, { items: [] }) || { items: [] };
      const rawItems = Array.isArray(queue.items) ? queue.items : [];
      let variants = new Map();
      try {
        variants = indexParts(loadParts(config)).variants;
      } catch {
        /* 零件表读不到时只显示审核快照 */
      }
      const items = rawItems.map((item) => {
        const variant = item.match?.variantId ? variants.get(item.match.variantId) : null;
        return {
          ...item,
          currentLinks: normalizeLinks(variant?.links || item.match?.links || []),
          currentVariant: variant
            ? {
                id: variant.id,
                name: variant.name,
                price: variant.price,
                manufacturer: variant.manufacturer || "",
                model: variant.model || "",
              }
            : null,
        };
      });
      const counts = items.reduce(
        (acc, item) => {
          acc[item.status || "unknown"] = (acc[item.status || "unknown"] || 0) + 1;
          return acc;
        },
        { pending: 0, approved: 0, rejected: 0 },
      );
      const status = String(url.searchParams.get("status") || "");
      const filtered = status ? items.filter((item) => item.status === status) : items;
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 200));
      return json(res, 200, {
        ok: true,
        items: filtered.slice(0, limit),
        counts,
        total: items.length,
        pending: counts.pending,
        linkRule: { primary: 1, secondary: 3 },
      });
    }

    const approveMatch = path.match(/^\/api\/review\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const body = await readBody(req).catch(() => ({}));
      const result = await approveReview(decodeURIComponent(approveMatch[1]), body);
      if (result.status === 200) {
        log("info", `审核通过 · ${result.body.item.partTypeCode} · ¥${result.body.item.decidedPrice}`, {
          itemId: result.body.item.id,
        });
      }
      return json(res, result.status, result.body);
    }

    const rejectMatch = path.match(/^\/api\/review\/([^/]+)\/reject$/);
    if (req.method === "POST" && rejectMatch) {
      const body = await readBody(req).catch(() => ({}));
      const result = rejectReview(decodeURIComponent(rejectMatch[1]), body);
      if (result.status === 200) {
        log("warn", `审核驳回 · ${result.body.item.partTypeCode}`, { itemId: result.body.item.id });
      }
      return json(res, result.status, result.body);
    }

    if (req.method === "POST" && path === "/api/run") {
      const body = await readBody(req).catch(() => ({}));
      const { runId, promise } = startRun({
        trigger: "manual",
        partTypeCodes: Array.isArray(body.partTypeCodes) ? body.partTypeCodes : null,
        dryRun: Boolean(body.dryRun),
      });
      promise.catch((error) => log("error", `手动抓取失败：${error.message}`));
      return json(res, 202, { ok: true, runId, started: true });
    }

    if (req.method === "GET" && path === "/api/runs") {
      return json(res, 200, { ok: true, runs: listRuns() });
    }

    const functionsMatch = path.match(/^\/api\/runs\/([^/]+)\/functions$/);
    if (req.method === "GET" && functionsMatch) {
      const runId = safeRunId(decodeURIComponent(functionsMatch[1]));
      if (!runId) return json(res, 400, { error: "runId 不合法" });
      const file = join(config.runsDir, runId, "functions.jsonl");
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 100));
      const lines = readLines(file).slice(-limit);
      return json(res, 200, { ok: true, runId, entries: lines });
    }

    const runMatch = path.match(/^\/api\/runs\/([^/]+)(?:\/(staging|decisions))?$/);
    if (req.method === "GET" && runMatch) {
      const runId = safeRunId(decodeURIComponent(runMatch[1]));
      if (!runId) return json(res, 400, { error: "runId 不合法" });
      const file = runMatch[2] ? `${runMatch[2]}.json` : "meta.json";
      const data = readJson(join(config.runsDir, runId, file), null);
      if (!data) return json(res, 404, { error: "run 不存在" });
      return json(res, 200, { ok: true, data });
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    log("error", `HTTP ${req.method} ${path} 失败：${error.message}`);
    return json(res, 500, { error: String(error?.message || error) });
  }
});

function readLines(file) {
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  } catch {
    return [];
  }
}

async function runDaily(trigger) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { promise } = startRun({ trigger });
      return await promise;
    } catch (error) {
      lastError = error;
      console.error(`定时抓取第 ${attempt} 次失败：${error.message}`);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
  throw lastError;
}

server.listen(config.port, config.host, () => {
  log("info", `ATLAS Market Watch v${VERSION} 启动`);
  log("info", `第一页 ${config.appUrl}/ · 第二页 ${config.appUrl}/next.html`);
  log("info", "后端 · 审核 /review · 手动抓取 /run · 检查 /inspect");
  log(
    "info",
    `平台 ${config.platform}${config.simulated ? "（模拟数据）" : ""} · AI ${
      bootAi.mock ? "mock" : bootAi.model
    } · 写回 ${config.simulated && !config.allowSimulatedWrite ? "dry-run" : "enabled"}`,
  );
  log("info", `AI 配置 ${config.aiConfigFile}（改完保存即生效，无需重启）`);
  log("info", `零件表 ${config.partsFile}`);
  startScheduler(config, async (trigger) => {
    if (currentRun) return;
    await runDaily(trigger);
  });
  if (config.runOnStart) {
    setTimeout(() => {
      if (currentRun) return;
      const { promise } = startRun({ trigger: "startup" });
      promise.catch((error) => log("error", `启动抓取失败：${error.message}`));
    }, 3000);
  }
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});
