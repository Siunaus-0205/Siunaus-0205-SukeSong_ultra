/**
 * 每日市场零件管线。
 *
 * 固定顺序：
 *   搜索 → 销量门槛 → 详情 → AI 判类型 → AI 抽字段 → 临时表
 *   → AI 合并同款 → 剔除异常价 → 与现有零件表比对 → 提交审核 / 写入
 *
 * 所有写操作都经过 functions.mjs；AI 判断都经过 tool-schemas.mjs 的契约。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createAiContext, extractListing, judgeType, mergePart, sameProduct } from "./ai-functions.mjs";
import { loadAiSettings } from "./ai.mjs";
import { createFunctionLayer } from "./functions.mjs";
import { normalizeLinks } from "./links.mjs";
import { findVariantByMakerModel, indexParts, loadParts, loadTable1, makerKey, normalizeKey } from "./parts.mjs";
import { createMockSource } from "./source-mock.mjs";
import { createSource1688 } from "./source-1688.mjs";
import { readJson, runFile, timestampId, updateState, writeJsonAtomic } from "./store.mjs";

const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function acquireLock(config, runId) {
  if (existsSync(config.lockFile)) {
    const age = Date.now() - Number(readJson(config.lockFile, {})?.at || 0);
    if (age < LOCK_MAX_AGE_MS) {
      throw new Error("已有一次抓取在运行，稍后再试。");
    }
  }
  writeFileSync(
    config.lockFile,
    JSON.stringify({ pid: process.pid, runId, at: Date.now() }),
    "utf8",
  );
}

function releaseLock(config) {
  try {
    unlinkSync(config.lockFile);
  } catch {
    /* ignore */
  }
}

function load1688Seeds(config) {
  if (!config.seeds1688File || !existsSync(config.seeds1688File)) return {};
  try {
    return JSON.parse(readFileSync(config.seeds1688File, "utf8"));
  } catch (error) {
    console.warn(`  [1688] 种子文件解析失败（${config.seeds1688File}）：${error.message}`);
    return {};
  }
}

function sourceFor(config) {
  if (config.platform === "mock") return createMockSource();
  if (config.platform === "1688" || config.platform === "alibaba") {
    return createSource1688({
      cookie: config.cookie1688,
      delayMs: config.delay1688Ms,
      limit: config.limit1688,
      seeds: load1688Seeds(config),
      direct: config.direct1688,
    });
  }
  if (config.platform === "taobao" || config.platform === "douyin") {
    throw new Error(
      `${config.platform} 的 API 尚未接入：请先在 market-config.env 里配置平台凭据，并实现 lib/source-${config.platform}.mjs。`,
    );
  }
  throw new Error(`未知平台：${config.platform}`);
}

function groupByMakerModel(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${makerKey(row.manufacturer)}|${normalizeKey(row.model)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

function primaryLink(rows, median) {
  return [...rows]
    .sort((a, b) => {
      const distance = Math.abs(a.price - median) - Math.abs(b.price - median);
      if (distance !== 0) return distance;
      return b.monthlySales - a.monthlySales;
    })
    .slice(0, 4)
    .map((row, index) => ({
      url: row.url,
      shop: row.shop,
      price: row.price,
      monthlySales: row.monthlySales,
      primary: index === 0,
      capturedAt: row.capturedAt,
    }));
}

export async function runPipeline(config, { trigger = "manual", runId, partTypeCodes = null, dryRun = false } = {}) {
  const id = runId || timestampId();
  acquireLock(config, id);
  const startedAt = new Date().toISOString();

  try {
    const table1 = loadTable1(config);
    const parts = loadParts(config);
    const { types } = indexParts(parts);
    const source = sourceFor(config);
    const aiCtx = createAiContext({
      ...config,
      aiSettings: loadAiSettings(config.aiConfigFile, config.aiTimeoutMs, {
        forceMock: config.aiMock,
      }),
    });
    const fn = createFunctionLayer(config, id, (message) => console.log(`  ${message}`));

    const selected = partTypeCodes?.length
      ? table1.partTypes.filter((part) => partTypeCodes.includes(part.code))
      : table1.partTypes;
    if (selected.length === 0) throw new Error("没有匹配的零件类型。");

    const staging = [];
    const tempRows = [];
    const results = [];
    const skippedTypes = [];
    const totals = {
      listings: 0,
      aboveThreshold: 0,
      detailFetched: 0,
      typeAccepted: 0,
      typeRejected: 0,
      rows: 0,
      groups: 0,
      created: 0,
      updated: 0,
      reviewed: 0,
      outliersRemoved: 0,
      skipped: 0,
    };
    let committed = false;

    /**
     * 单个类型抓不到（没种子 / 没有候选）不该拖垮整轮：记下来跳过，其余类型继续。
     * 真正的风控要整轮停——继续请求只会加重惩罚，所以 SourceBlockedError 照样上抛。
     */
    async function searchType(partType, context) {
      try {
        return await source.search(partType, context);
      } catch (error) {
        if (error?.name === "SourceBlockedError") throw error;
        totals.skipped += 1;
        skippedTypes.push({
          partTypeCode: partType.code,
          partTypeName: partType.name,
          reason: error.message,
        });
        console.warn(`[${partType.code}] 跳过：${error.message}`);
        return null;
      }
    }

    for (const partType of selected) {
      const typeEntry = types.get(partType.code);
      const baseline = typeEntry?.variants?.find(
        (variant) => variant.id === typeEntry.baselineVariantId,
      );
      console.log(`[${partType.code}] ${partType.name}`);

      const listings = await searchType(partType, {
        baselinePrice: baseline?.price,
        baselineSpec: baseline?.spec || partType.spec,
        baselineMaterial: baseline?.material || partType.material,
      });
      if (!listings) continue;
      totals.listings += listings.length;

      const sorted = [...listings].sort((a, b) => b.sales - a.sales);
      const refIndex = Math.min(config.rank, sorted.length) - 1;
      const threshold = sorted.length
        ? Math.max(0, Math.floor(sorted[refIndex].sales * config.salesRatio))
        : 0;
      const candidates = listings
        .filter((listing) => listing.sales >= threshold && listing.sales > 0)
        .slice(0, config.maxResults);
      totals.aboveThreshold += candidates.length;

      const rows = [];
      for (const listing of candidates) {
        const detail = await source.detail(listing);
        totals.detailFetched += 1;

        const verdict = await judgeType(aiCtx, { partType, listing, detailText: detail.text });
        if (!verdict.args.belongs || verdict.args.confidence < config.minConfidence) {
          totals.typeRejected += 1;
          tempRows.push({
            runId: id,
            status: "type_rejected",
            partTypeCode: partType.code,
            partTypeName: partType.name,
            title: listing.title,
            url: listing.url,
            shop: listing.shop,
            manufacturer: detail.manufacturer || "",
            model: detail.model || "",
            price: Number(detail.price) || 0,
            monthlySales: detail.monthlySales ?? listing.sales ?? 0,
            params: detail.params || [],
            reason: verdict.args.reason,
            capturedAt: new Date().toISOString(),
          });
          if (verdict.args.confidence < config.minConfidence) {
            fn.submitReview({
              partTypeCode: partType.code,
              partTypeName: partType.name,
              group: {
                manufacturer: detail.manufacturer || "",
                model: detail.model || "",
                title: listing.title,
                url: listing.url,
                medianPrice: Number(detail.price) || 0,
              },
              match: null,
              reason: `类型判定置信度低（${verdict.args.confidence}）：${verdict.args.reason}`,
            });
          }
          continue;
        }
        totals.typeAccepted += 1;

        const extraction = await extractListing(aiCtx, { partType, listing, detailText: detail.text });
        const fields = extraction.args;
        if (fields.confidence < config.minConfidence) {
          totals.typeRejected += 1;
          tempRows.push({
            runId: id,
            status: "type_rejected",
            partTypeCode: partType.code,
            partTypeName: partType.name,
            title: listing.title,
            url: listing.url,
            shop: listing.shop,
            manufacturer: fields.manufacturer,
            model: fields.model,
            price: fields.price,
            monthlySales: fields.monthlySales,
            params: fields.params,
            reason: `字段抽取置信度低（${fields.confidence}）`,
            capturedAt: new Date().toISOString(),
          });
          continue;
        }
        const row = {
          runId: id,
          status: "accepted",
          title: listing.title,
          url: listing.url,
          shop: listing.shop,
          partTypeCode: partType.code,
          partTypeName: partType.name,
          manufacturer: fields.manufacturer,
          model: fields.model,
          price: fields.price,
          monthlySales: fields.monthlySales,
          params: fields.params,
          spec: fields.spec || "",
          confidence: fields.confidence,
          capturedAt: new Date().toISOString(),
        };
        rows.push(row);
        tempRows.push(row);
        totals.rows += 1;
      }

      const groups = groupByMakerModel(rows);
      totals.groups += groups.length;
      for (const groupRows of groups) {
        const merged = await mergePart(aiCtx, { partType, rows: groupRows });
        const cleaned = fn.excludePriceOutliers({
          partTypeCode: partType.code,
          listings: groupRows,
          ratio: config.outlierRatio,
          rounds: config.outlierRounds,
        });
        totals.outliersRemoved += cleaned.removed.length;

        const kept = cleaned.kept;
        for (const row of cleaned.removed) {
          row.status = "outlier";
          row.groupMedian = cleaned.median;
          row.reason = `偏离中位价 ${((Math.abs(row.price - cleaned.median) / cleaned.median) * 100).toFixed(1)}%，已剔除`;
        }
        for (const row of kept) {
          row.status = "kept";
          row.groupMedian = cleaned.median;
        }

        const group = {
          partTypeCode: partType.code,
          partTypeName: partType.name,
          manufacturer: merged.args.manufacturer,
          model: merged.args.model,
          displayName: merged.args.displayName,
          codeSuffix: merged.args.codeSuffix,
          params: merged.args.params,
          medianPrice: cleaned.median,
          listings: kept,
          links: primaryLink(kept, cleaned.median),
          spec: merged.args.params.slice(0, 3).map((item) => item.value).join(" · "),
        };
        staging.push({ type: partType.code, group, rows: groupRows });

        const match = findVariantByMakerModel(parts, partType.code, group.manufacturer, group.model);
        const decision = {
          partTypeCode: partType.code,
          partTypeName: partType.name,
          manufacturer: group.manufacturer,
          model: group.model,
          medianPrice: group.medianPrice,
          listings: kept.length,
          action: "",
          variantId: match?.variant?.id || "",
          reason: "",
        };

        if (match) {
          const oldPrice = Number(match.variant.price) || 0;
          const priceDelta = oldPrice > 0 ? Math.abs(group.medianPrice - oldPrice) / oldPrice : 1;
          if (priceDelta > config.samePriceTolerance) {
            decision.action = "review";
            decision.reason = `价格差异 ${(priceDelta * 100).toFixed(1)}% 超过 ${(config.samePriceTolerance * 100).toFixed(0)}%`;
            fn.submitReview({
              partTypeCode: partType.code,
              partTypeName: partType.name,
              group,
              match: {
                variantId: match.variant.id,
                price: oldPrice,
                name: match.variant.name,
                manufacturer: match.variant.manufacturer || "",
                model: match.variant.model || "",
                links: normalizeLinks(match.variant.links),
              },
              reason: decision.reason,
            });
            totals.reviewed += 1;
          } else {
            const verdict = await sameProduct(aiCtx, {
              partType,
              existing: match.variant,
              group,
              priceDelta,
            });
            if (verdict.args.same && verdict.args.confidence >= config.minConfidence) {
              fn.commitMarketPart(
                {
                  action: "update",
                  partTypeCode: partType.code,
                  variantId: match.variant.id,
                  manufacturer: group.manufacturer,
                  model: group.model,
                  displayName: group.displayName,
                  price: group.medianPrice,
                  params: group.params,
                  spec: group.spec,
                  links: group.links,
                  source: source.label,
                },
                parts,
              );
              decision.action = "update";
              decision.reason = `同款，价差 ${(priceDelta * 100).toFixed(1)}%`;
              totals.updated += 1;
              committed = true;
            } else {
              decision.action = "review";
              decision.reason = `参数判断未通过：${verdict.args.reason}`;
              fn.submitReview({
                partTypeCode: partType.code,
                partTypeName: partType.name,
                group,
                match: {
                variantId: match.variant.id,
                price: oldPrice,
                name: match.variant.name,
                manufacturer: match.variant.manufacturer || "",
                model: match.variant.model || "",
                links: normalizeLinks(match.variant.links),
              },
                reason: decision.reason,
              });
              totals.reviewed += 1;
            }
          }
        } else {
          fn.commitMarketPart(
            {
              action: "create",
              partTypeCode: partType.code,
              codeSuffix: group.codeSuffix,
              manufacturer: group.manufacturer,
              model: group.model,
              displayName: group.displayName,
              price: group.medianPrice,
              params: group.params,
              spec: group.spec,
              links: group.links,
              source: source.label,
            },
            parts,
          );
          decision.action = "create";
          decision.reason = "新厂家 / 新车型号";
          totals.created += 1;
          committed = true;
        }
        results.push(decision);
      }
    }

    const writeEnabled = !dryRun && (!config.simulated || config.allowSimulatedWrite);
    let write = { enabled: writeEnabled, backup: null };
    if (committed && writeEnabled) {
      const written = fn.writePartsFile(parts);
      write.backup = written.backup;
    } else if (committed) {
      writeJsonAtomic(join(runFile(config, id, "parts.next.json")), parts);
    }

    const finishedAt = new Date().toISOString();
    const summary = {
      runId: id,
      trigger,
      platform: config.platform,
      simulated: config.simulated,
      startedAt,
      finishedAt,
      durationMs: Date.now() - Date.parse(startedAt),
      partTypes: selected.length,
      totals,
      write,
      ai: { mode: aiCtx.settings.mock ? "mock" : "live", model: aiCtx.settings.model },
    };

    summary.tempRows = tempRows.length;
    summary.skippedTypes = skippedTypes;
    writeJsonAtomic(runFile(config, id, "meta.json"), summary);
    writeJsonAtomic(runFile(config, id, "staging.json"), tempRows);
    writeJsonAtomic(runFile(config, id, "groups.json"), staging);
    writeJsonAtomic(runFile(config, id, "decisions.json"), results);
    writeJsonAtomic(config.tempFile, {
      runId: id,
      createdAt: finishedAt,
      rows: tempRows,
      totals,
      skippedTypes,
    });

    updateState(config, {
      lastRun: summary,
      lastRunStatus: "ok",
      lastRunAt: finishedAt,
    });
    return summary;
  } catch (error) {
    updateState(config, {
      lastRunStatus: "failed",
      lastRunError: String(error?.message || error),
      lastRunAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    releaseLock(config);
  }
}
