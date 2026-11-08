import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadAiSettings } from "../lib/ai.mjs";
import { loadConfig } from "../lib/config.mjs";
import {
  createFunctionLayer,
  excludeOutliers,
  salesThreshold,
  weightedMedian,
} from "../lib/functions.mjs";
import { indexParts, loadParts, makerKey, makerMatches, normalizeKey, validatePartsDocument } from "../lib/parts.mjs";
import { mergeLinks, normalizeLinks, normalizeLinkUrl } from "../lib/links.mjs";
import { runPipeline } from "../lib/pipeline.mjs";
import { validate } from "../lib/schema.mjs";
import { TOOL_SCHEMAS } from "../lib/tool-schemas.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PARTS_SOURCE = join(HERE, "fixtures/h3-parts-baseline.json");

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "market-watch-"));
  const partsFile = join(dir, "h3-parts.json");
  copyFileSync(PARTS_SOURCE, partsFile);
  const config = loadConfig({
    MARKET_PARTS_FILE: partsFile,
    MARKET_DATA_DIR: join(dir, "data"),
    MARKET_AI_MOCK: "1",
    MARKET_ALLOW_SIMULATED_WRITE: "1",
    MARKET_SCHEDULE_ENABLED: "0",
  });
  config.aiSettings = loadAiSettings(config.aiConfigFile, config.aiTimeoutMs, { forceMock: true });
  return { dir, partsFile, config };
}

test("加权中位数按销量排序累计", () => {
  assert.equal(
    weightedMedian([
      { price: 10, monthlySales: 10 },
      { price: 20, monthlySales: 10 },
      { price: 30, monthlySales: 10 },
    ]),
    20,
  );
  assert.equal(
    weightedMedian([
      { price: 10, monthlySales: 0 },
      { price: 20, monthlySales: 0 },
      { price: 30, monthlySales: 0 },
    ]),
    20,
  );
});

test("异常价逐轮剔除并重算中位价", () => {
  const result = excludeOutliers(
    [
      { price: 98, monthlySales: 100 },
      { price: 100, monthlySales: 100 },
      { price: 101, monthlySales: 100 },
      { price: 102, monthlySales: 100 },
      { price: 300, monthlySales: 100 },
    ],
    { ratio: 0.4, rounds: 3 },
  );
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].price, 300);
  assert.equal(result.median, 100);
});

test("销量门槛 = 第 10 名 × 70%", () => {
  const listings = Array.from({ length: 12 }, (_, index) => ({ sales: 1000 - index * 50 }));
  assert.equal(salesThreshold(listings, { rank: 10, ratio: 0.7 }), Math.floor(550 * 0.7));
});

test("厂家 / 型号归一化", () => {
  assert.equal(normalizeKey("H3-CAM 01"), normalizeKey("h3cam01"));
  assert.equal(normalizeKey("凌越 智造"), normalizeKey("凌越智造"));
  assert.notEqual(normalizeKey("A厂"), normalizeKey("B厂"));
});

test("厂家简称与全称视为同一家（避免每轮抓取多出一个重复型号）", () => {
  // AI 两次抽取可能一个给全称、一个给简称，型号一致时必须认成同一家
  assert.equal(makerMatches("深圳市多视界科技有限公司", "多视界"), true);
  assert.equal(makerMatches("深圳市栋芯光电科技有限公司", "栋芯光电"), true);
  assert.equal(makerKey("深圳市栋芯光电科技有限公司"), makerKey("栋芯光电"));
  // 不同厂家不能误合并
  assert.equal(makerMatches("深圳市栋芯光电科技有限公司", "多视界"), false);
  assert.equal(makerKey("深圳市多视界科技有限公司"), "多视界");
});

test("AI 函数参数不合规会被拒绝", () => {
  assert.throws(
    () =>
      validate(TOOL_SCHEMAS.judge_part_type, {
        partTypeCode: "h3-cam-01",
        belongs: "yes",
        confidence: 2,
        reason: "",
      }),
    /期望 boolean|不能大于 1|必填/,
  );
  assert.doesNotThrow(() =>
    validate(TOOL_SCHEMAS.merge_market_part, {
      manufacturer: "凌越智造",
      model: "H3CAM01-105",
      displayName: "相机模组 · H3CAM01-105",
      codeSuffix: "m105",
      params: [{ label: "材质", value: "铝合金" }],
      confidence: 0.9,
      reason: "同款合并",
    }),
  );
});

test("写入函数创建四段编号并可更新", () => {
  const { dir, partsFile, config } = sandbox();
  try {
    const doc = loadParts(config);
    const fn = createFunctionLayer(config, "test-run");
    const created = fn.commitMarketPart(
      {
        action: "create",
        partTypeCode: "h3-cam-01",
        codeSuffix: "m777",
        manufacturer: "测试厂家",
        model: "TEST-777",
        displayName: "相机模组 · TEST-777",
        price: 123.45,
        params: [{ label: "材质", value: "铝合金" }],
        links: [{ url: "https://example.com/1", primary: true }],
        source: "test",
      },
      doc,
    );
    assert.equal(created.variantId, "h3-cam-01-m777");
    fn.writePartsFile(doc);

    const reloaded = loadParts(config);
    const { variants } = indexParts(reloaded);
    assert.equal(variants.get("h3-cam-01-m777").model, "TEST-777");

    const fn2 = createFunctionLayer(config, "test-run-2");
    fn2.commitMarketPart(
      {
        action: "update",
        partTypeCode: "h3-cam-01",
        variantId: "h3-cam-01-m777",
        manufacturer: "测试厂家",
        model: "TEST-777",
        displayName: "相机模组 · TEST-777",
        price: 199,
        params: [{ label: "材质", value: "铝合金" }],
        source: "test",
      },
      reloaded,
    );
    fn2.writePartsFile(reloaded);
    assert.equal(indexParts(loadParts(config)).variants.get("h3-cam-01-m777").price, 199);
    assert.ok(existsSync(join(config.backupsDir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("链接规则：1 条 true + 至多 3 条 false，地址去重", () => {
  const links = normalizeLinks([
    { url: "https://shop.example.com/item?id=1&spm=abc", primary: true },
    { url: "https://shop.example.com/item?id=1", primary: false },
    { url: "https://shop.example.com/item?id=2" },
    { url: "https://shop.example.com/item?id=3" },
    { url: "https://shop.example.com/item?id=4" },
    { url: "https://shop.example.com/item?id=5" },
    { url: "javascript:alert(1)", primary: true },
  ]);
  assert.equal(links.length, 4);
  assert.equal(links.filter((link) => link.primary).length, 1);
  assert.equal(links.filter((link) => !link.primary).length, 3);
  assert.equal(new Set(links.map((link) => link.url)).size, 4);
  assert.equal(links[0].url, "https://shop.example.com/item?id=1");
  assert.equal(normalizeLinkUrl("https://Shop.Example.com/a/#x"), "https://shop.example.com/a");
  assert.equal(
    normalizeLinkUrl("https://shop.example.com/item?b=2&a=1"),
    normalizeLinkUrl("https://shop.example.com/item?a=1&b=2"),
  );
});

test("合并链接时保留现有 true 链接，新链接优先占备选位", () => {
  const merged = mergeLinks(
    [
      { url: "https://old.example.com/primary", primary: true },
      { url: "https://old.example.com/b", primary: false },
    ],
    [
      { url: "https://new.example.com/a", primary: true },
      { url: "https://new.example.com/b" },
      { url: "https://new.example.com/c" },
      { url: "https://new.example.com/d" },
    ],
  );
  assert.equal(merged.length, 4);
  assert.equal(merged[0].url, "https://old.example.com/primary");
  assert.equal(merged[0].primary, true);
  assert.deepEqual(
    merged.slice(1).map((link) => link.url),
    ["https://new.example.com/a", "https://new.example.com/b", "https://new.example.com/c"],
  );
  assert.ok(merged.slice(1).every((link) => link.primary === false));
});

test("写盘校验拒绝超过 3 条 false、重复地址或没有 true 的链接", () => {
  const doc = loadParts(
    loadConfig({
      MARKET_PARTS_FILE: PARTS_SOURCE,
      MARKET_DATA_DIR: join(tmpdir(), `market-watch-validate-${Date.now()}`),
    }),
  );
  const part = doc.modules[0].parts.find((item) => item.code === "h3-cam-01");
  const variant = part.variants.find((item) => item.id === "h3-cam-01-std");
  const base = {
    url: "https://shop.example.com/item",
    primary: true,
  };
  variant.links = [base];
  assert.equal(validatePartsDocument(doc).length, 0);

  variant.links = [
    base,
    { url: "https://shop.example.com/a" },
    { url: "https://shop.example.com/b" },
    { url: "https://shop.example.com/c" },
    { url: "https://shop.example.com/d" },
  ];
  assert.ok(validatePartsDocument(doc).some((error) => error.includes("超过上限")));

  variant.links = [base, { url: "https://shop.example.com/item#detail" }];
  assert.ok(validatePartsDocument(doc).some((error) => error.includes("重复地址")));

  variant.links = [{ url: "https://shop.example.com/a" }, { url: "https://shop.example.com/b" }];
  assert.ok(validatePartsDocument(doc).some((error) => error.includes("必须有 1 条标记为 true")));
});

test("mock 全链路：合并、剔除、创建、写回", async () => {
  const { dir, partsFile, config } = sandbox();
  try {
    const before = readFileSync(partsFile, "utf8");
    const summary = await runPipeline(config, {
      trigger: "test",
      runId: "pipeline-test",
      partTypeCodes: ["h3-cam-01", "h3-pwr-01"],
    });
    assert.equal(summary.totals.groups > 0, true);
    assert.equal(summary.totals.created > 0, true);
    assert.equal(summary.totals.outliersRemoved > 0, true);
    assert.equal(summary.totals.typeRejected > 0, true);
    assert.equal(summary.write.enabled, true);
    assert.notEqual(readFileSync(partsFile, "utf8"), before);

    const temp = JSON.parse(readFileSync(config.tempFile, "utf8"));
    assert.equal(temp.runId, "pipeline-test");
    assert.ok(temp.rows.some((row) => row.status === "kept"));
    assert.ok(temp.rows.some((row) => row.status === "outlier"));
    assert.ok(temp.rows.some((row) => row.status === "type_rejected"));

    const doc = loadParts(config);
    const { variants } = indexParts(doc);
    const created = [...variants.values()].filter((variant) => variant.tier === "市场");
    assert.ok(created.length > 0);
    for (const variant of created) {
      assert.ok(variant.manufacturer);
      assert.ok(variant.model);
      assert.equal(variant.id.split("-").length, 4);
      assert.ok(Array.isArray(variant.links));
    }

    const second = await runPipeline(config, {
      trigger: "test",
      runId: "pipeline-test-2",
      partTypeCodes: ["h3-cam-01", "h3-pwr-01"],
    });
    assert.equal(second.totals.created, 0);
    assert.ok(second.totals.updated > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("模拟数据默认不写回真实零件表", async () => {
  const { dir, partsFile, config } = sandbox();
  try {
    config.allowSimulatedWrite = false;
    const before = readFileSync(partsFile, "utf8");
    const summary = await runPipeline(config, {
      trigger: "test",
      runId: "dry-run",
      partTypeCodes: ["h3-cam-01"],
    });
    assert.equal(summary.write.enabled, false);
    assert.equal(readFileSync(partsFile, "utf8"), before);
    assert.ok(existsSync(join(config.runsDir, "dry-run", "parts.next.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
