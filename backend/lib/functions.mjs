/**
 * 确定性后端函数：剔除异常价、提交人工审核、写入 / 写回零件表。
 *
 * AI 不能直接改任何文件；所有变更都必须经过这里的函数入口，
 * 每次调用都会写进 runs/<runId>/functions.jsonl，便于审计。
 */

import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { appendJsonl, readJson, runDir, writeJsonAtomic } from "./store.mjs";
import { writeParts } from "./parts.mjs";

import { mergeLinks, normalizeLinks } from "./links.mjs";

export { MAX_SECONDARY_LINKS, normalizeLinkUrl, normalizeLinks, mergeLinks, primaryLinks } from "./links.mjs";

function fail(message) {
  throw new Error(`函数参数不合法：${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function requireString(value, name, max = 200) {
  assert(typeof value === "string" && value.trim(), `${name} 必须是非空字符串`);
  assert(value.length <= max, `${name} 不能超过 ${max} 字`);
  return value.trim();
}

function requireNumber(value, name, { min = -Infinity, max = Infinity } = {}) {
  assert(typeof value === "number" && Number.isFinite(value), `${name} 必须是数字`);
  assert(value >= min && value <= max, `${name} 超出范围`);
  return value;
}

/** 销量加权中位数：按价格排序，累计销量首次达到一半时的价格。 */
export function weightedMedian(listings) {
  const rows = listings
    .map((item) => ({
      price: Number(item.price),
      weight: Math.max(0, Number(item.monthlySales) || 0),
    }))
    .filter((item) => Number.isFinite(item.price) && item.price > 0)
    .sort((a, b) => a.price - b.price);
  if (rows.length === 0) return 0;
  const total = rows.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) {
    const middle = (rows.length - 1) / 2;
    const low = rows[Math.floor(middle)].price;
    const high = rows[Math.ceil(middle)].price;
    return (low + high) / 2;
  }
  let cumulative = 0;
  for (const row of rows) {
    cumulative += row.weight;
    if (cumulative >= total / 2) return row.price;
  }
  return rows[rows.length - 1].price;
}

/**
 * 逐轮剔除偏离中位价超过 ratio 的报价，直到没有可剔除项或达到轮数上限。
 * 每轮都会重算中位价。
 */
export function excludeOutliers(listings, { ratio = 0.4, rounds = 3 } = {}) {
  let kept = listings.filter((item) => Number(item.price) > 0);
  const removed = [];
  const history = [];
  for (let round = 1; round <= rounds; round += 1) {
    const median = weightedMedian(kept);
    if (!median) break;
    const next = kept.filter((item) => Math.abs(item.price - median) / median <= ratio);
    const dropped = kept.length - next.length;
    history.push({ round, median, kept: next.length, dropped });
    if (dropped === 0) break;
    removed.push(...kept.filter((item) => !next.includes(item)));
    kept = next;
    if (kept.length <= 1) break;
  }
  return { kept, removed, median: weightedMedian(kept), history };
}

export function salesThreshold(listings, { rank = 10, ratio = 0.7 } = {}) {
  const sorted = [...listings].filter((item) => Number(item.sales) > 0).sort((a, b) => b.sales - a.sales);
  if (sorted.length === 0) return 0;
  const index = Math.min(rank, sorted.length) - 1;
  return Math.max(0, Math.floor(Number(sorted[index].sales) * ratio));
}

function reviewId(runId, partTypeCode, manufacturer, model) {
  return [runId, partTypeCode, manufacturer, model]
    .join("-")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "")
    .slice(0, 120);
}

export function createFunctionLayer(config, runId, logger = () => {}) {
  const logPath = join(runDir(config, runId), "functions.jsonl");
  const record = (name, args, result, extra = {}) => {
    const entry = {
      at: new Date().toISOString(),
      runId,
      name,
      args,
      result,
      ...extra,
    };
    appendJsonl(logPath, entry);
    logger(`函数 ${name}`, extra);
    return result;
  };

  return {
    /** 剔除异常价（确定性）。 */
    excludePriceOutliers(args) {
      assert(args && typeof args === "object", "缺少参数");
      requireString(args.partTypeCode, "partTypeCode", 40);
      assert(Array.isArray(args.listings) && args.listings.length > 0, "listings 不能为空");
      const ratio = requireNumber(args.ratio ?? config.outlierRatio, "ratio", { min: 0.01, max: 1 });
      const rounds = Math.round(requireNumber(args.rounds ?? config.outlierRounds, "rounds", { min: 1, max: 6 }));
      const result = excludeOutliers(args.listings, { ratio, rounds });
      record(
        "exclude_price_outliers",
        { partTypeCode: args.partTypeCode, ratio, rounds, count: args.listings.length },
        {
          kept: result.kept.length,
          removed: result.removed.length,
          median: result.median,
          history: result.history,
        },
      );
      return result;
    },

    /** 提交人工审核（确定性）。 */
    submitReview(args) {
      assert(args && typeof args === "object", "缺少参数");
      requireString(args.partTypeCode, "partTypeCode", 40);
      requireString(args.reason, "reason", 400);
      const queue = readJson(config.reviewFile, { items: [] }) || { items: [] };
      const items = Array.isArray(queue.items) ? queue.items : [];
      const id = reviewId(runId, args.partTypeCode, args.group?.manufacturer || "", args.group?.model || "");
      const existing = items.find((item) => item.id === id && item.status === "pending");
      const group = args.group
        ? { ...args.group, links: normalizeLinks(args.group.links) }
        : args.group;
      const item = {
        id,
        runId,
        partTypeCode: args.partTypeCode,
        partTypeName: args.partTypeName || "",
        group,
        match: args.match || null,
        reason: args.reason,
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      if (existing) Object.assign(existing, item);
      else items.unshift(item);
      writeJsonAtomic(config.reviewFile, { items });
      return record("submit_review", { partTypeCode: args.partTypeCode, id }, { id, pending: items.filter((row) => row.status === "pending").length });
    },

    /** 写入内存中的零件库：create 或 update，不落盘。 */
    commitMarketPart(args, doc) {
      assert(args && typeof args === "object", "缺少参数");
      requireString(args.partTypeCode, "partTypeCode", 40);
      requireString(args.action, "action", 10);
      assert(["create", "update"].includes(args.action), "action 只能是 create / update");
      requireString(args.manufacturer, "manufacturer", 80);
      requireString(args.model, "model", 80);
      requireNumber(args.price, "price", { min: 0.01 });

      let target = null;
      for (const module of doc.modules || []) {
        const part = (module.parts || []).find((item) => item.code === args.partTypeCode);
        if (part) target = { module, part };
      }
      assert(target, `找不到零件类型 ${args.partTypeCode}`);

      const params = Array.isArray(args.params) ? args.params.slice(0, 12) : [];
      const incomingLinks = normalizeLinks(args.links);
      const now = new Date().toISOString();

      if (args.action === "update") {
        const variant = target.part.variants.find((item) => item.id === args.variantId);
        assert(variant, `找不到型号 ${args.variantId}`);
        variant.price = Math.round(args.price * 100) / 100;
        if (params.length > 0) variant.params = params;
        if (args.displayName) variant.name = args.displayName.slice(0, 60);
        variant.manufacturer = args.manufacturer;
        variant.model = args.model;
        variant.links = mergeLinks(variant.links, incomingLinks);
        variant.updatedAt = now;
        variant.source = args.source || config.platformTag;
        return record(
          "commit_market_part",
          { action: "update", partTypeCode: args.partTypeCode, variantId: variant.id, price: variant.price },
          { variantId: variant.id, action: "update", links: variant.links.length },
        );
      }

      const suffix =
        String(args.codeSuffix || "")
          .normalize("NFKC")
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "")
          .replace(/^-+|-+$/g, "")
          .slice(0, 8) || "m01";
      let id = `${args.partTypeCode}-${suffix}`;
      let index = 2;
      while (target.part.variants.some((item) => item.id === id)) {
        id = `${args.partTypeCode}-${suffix}-${index}`;
        index += 1;
      }
      const baseline =
        target.part.variants.find((item) => item.id === target.part.baselineVariantId) ||
        target.part.variants[0];
      const variant = {
        id,
        tier: "市场",
        tierKey: "market",
        name: (args.displayName || `${target.part.name} · ${args.model}`).slice(0, 60),
        price: Math.round(args.price * 100) / 100,
        weight: baseline?.weight ?? 0,
        leadTime: baseline?.leadTime ?? 0,
        risk: "中",
        material: baseline?.material || "—",
        spec: args.spec || params.slice(0, 3).map((item) => item.value).join(" · ") || "—",
        owner: "市场抓取",
        description: `来自${args.source || config.platformTag}的在售商品：${args.manufacturer} ${args.model}，价格取销量加权中位价。`,
        params,
        manufacturer: args.manufacturer,
        model: args.model,
        links: incomingLinks,
        source: args.source || config.platformTag,
        capturedAt: now,
        updatedAt: now,
      };
      target.part.variants.push(variant);
      return record(
        "commit_market_part",
        { action: "create", partTypeCode: args.partTypeCode, variantId: variant.id, price: variant.price },
        { variantId: variant.id, action: "create", links: variant.links.length },
      );
    },

    /** 落盘（带备份与校验）。 */
    writePartsFile(doc) {
      const result = writeParts(config, doc);
      return record("write_parts_file", { file: config.partsFile }, { backup: result.backup, variants: countVariants(doc) });
    },
  };
}

function countVariants(doc) {
  let count = 0;
  for (const module of doc.modules || []) {
    for (const part of module.parts || []) count += (part.variants || []).length;
  }
  return count;
}

export function newReviewId() {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}
