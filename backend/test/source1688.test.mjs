import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createSource1688, isBlockedHtml, parseOfferHtml, parseSearchResults } from "../lib/source-1688.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OFFER_HTML = readFileSync(join(HERE, "fixtures/1688-offer.html"), "utf8");
const BLOCKED_HTML = readFileSync(join(HERE, "fixtures/1688-blocked.html"), "utf8");

test("1688 详情页：标题 / 厂家 / 价格 / 阶梯价 / 已售 / 属性 都能解析", () => {
  const parsed = parseOfferHtml(OFFER_HTML, "1072723637966");
  assert.equal(parsed.blocked, false);
  assert.equal(parsed.title, "GC4653摄像头模组MIPI接口10*10尺寸");
  assert.equal(parsed.company, "深圳市栋芯光电科技有限公司");
  assert.equal(parsed.price, 33.88);
  assert.deepEqual(parsed.tiers, [
    { price: 33.88, beginAmount: 1 },
    { price: 32.88, beginAmount: 500 },
  ]);
  assert.equal(parsed.sold, 100);
  assert.equal(parsed.soldText, "100+");
  assert.equal(parsed.unit, "台");
  assert.equal(parsed.model, "DL209-2M80-V1");
  assert.equal(parsed.manufacturer, "深圳市栋芯光电科技有限公司");
  assert.ok(parsed.attrs.length >= 10, `属性条数应足够多，实际 ${parsed.attrs.length}`);
  assert.match(parsed.text, /【批发价】/);
  assert.match(parsed.text, /【已售】100\+/);
});

test("1688 风控页能被识别，不会当成商品解析", () => {
  assert.equal(isBlockedHtml(BLOCKED_HTML), true);
  assert.equal(isBlockedHtml(OFFER_HTML), false);
  const parsed = parseOfferHtml(BLOCKED_HTML, "1072723637966");
  assert.equal(parsed.blocked, true);
  assert.equal(parsed.text, "");
});

test("搜索结果解析：uddg 跳转链接能还原成 offerId，并自动去重", () => {
  const html = `
    <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdetail.1688.com%2Foffer%2F123456789012.html&amp;rut=abc">摄像头模组 厂家</a>
    <a href="https://detail.1688.com/offer/123456789012.html">重复链接</a>
    <a href="https://detail.1688.com/offer/987654321098.html">另一个商品</a>
    <a href="https://example.com/offer/111111111111.html">非 1688</a>
  `;
  const hits = parseSearchResults(html);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((hit) => hit.id), ["123456789012", "987654321098"]);
  assert.equal(hits[0].url, "https://detail.1688.com/offer/123456789012.html");
});

test("种子链接优先：给定 seeds 时不访问搜索，直接抓详情", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return {
      status: 200,
      headers: { getSetCookie: () => [] },
      text: async () => OFFER_HTML,
    };
  };
  try {
    const source = createSource1688({
      limit: 1,
      delayMs: 1,
      direct: false, // 走被 stub 的 fetch，避免单测真的去连 1688
      seeds: { "h3-cam-01": ["https://detail.1688.com/offer/1072723637966.html"] },
    });
    const listings = await source.search({ code: "h3-cam-01", name: "相机模组" });
    assert.equal(listings.length, 1);
    assert.equal(listings[0].id, "1072723637966");
    assert.equal(listings[0].sales, 100);
    assert.equal(listings[0].listPrice, 33.88);
    assert.ok(requested.every((url) => url.includes("1688.com")), "不应去请求站外搜索");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
