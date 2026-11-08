/**
 * 1688（阿里巴巴批发）真实数据源。
 *
 * 两条链路：
 *   1. 搜索：DuckDuckGo 的 HTML 版做站内检索（`site:detail.1688.com <关键词>`），
 *      只取 offerId，不依赖 1688 自家搜索页（那个必须登录）；
 *   2. 详情：直接抓 `https://m.1688.com/offer/<id>.html`，从页面内嵌 JSON 里取
 *      标题 / 价格 / 阶梯价 / 已售 / 公司名 / 店铺地址 / 商品属性。
 *
 * 反爬注意：
 *   - 1688 对高频匿名请求会返回 `_____tmd_____/punish` 的滑块页（HTTP 200 但只有 2 KB）；
 *   - **国内家宽直连能过、走代理（Clash 之类）基本必挡**，所以 1688 的请求默认绕开系统代理
 *     （`MARKET_1688_DIRECT=0` 可关掉这个行为）；
 *   - 这里还做了：请求间固定 sleep + 抖动、同一进程内复用 Cookie、命中风控后指数退避重试；
 *   - 仍然被挡时抛 SourceBlockedError，由管线把这次运行标成失败并给出可操作的提示，
 *     而不是把假数据写进零件库。
 *
 * 想更稳：把浏览器登录后的 Cookie 整串贴到 market-config.env 的 MARKET_1688_COOKIE。
 */

import { get } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const OFFER_URL = (id) => `https://detail.1688.com/offer/${id}.html`;
const MOBILE_OFFER_URL = (id) => `https://m.1688.com/offer/${id}.html`;

/**
 * 不经过系统代理的 GET（node:https 默认就不读 HTTP(S)_PROXY）。
 * Node 的 fetch 会被 undici 的 EnvHttpProxyAgent 接管，走代理时 1688 直接给滑块页。
 */
function getDirect(url, headers, redirects = 4) {
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      { headers, timeout: 25_000 },
      (response) => {
        if (
          [301, 302, 303, 307, 308].includes(response.statusCode) &&
          response.headers.location &&
          redirects > 0
        ) {
          const next = new URL(response.headers.location, url).toString();
          response.resume();
          resolve(getDirect(next, headers, redirects - 1));
          return;
        }
        const encoding = response.headers["content-encoding"];
        let stream = response;
        if (encoding === "gzip") stream = response.pipe(createGunzip());
        else if (encoding === "deflate") stream = response.pipe(createInflate());
        else if (encoding === "br") stream = response.pipe(createBrotliDecompress());
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", () =>
          resolve({
            status: response.statusCode,
            html: Buffer.concat(chunks).toString("utf8"),
            setCookies: response.headers["set-cookie"] ?? [],
          }),
        );
        stream.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

export class SourceBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceBlockedError";
    this.code = "SOURCE_BLOCKED";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(text) {
  return decodeEntities(String(text).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** 从 1688 页面内嵌 JSON 里按 key 取字符串值。 */
function jsonString(html, key) {
  const match = html.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return match ? JSON.parse(`"${match[1]}"`) : "";
}

function jsonNumber(html, key) {
  const match = html.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
}

/** 解析价格阶梯：[{price, beginAmount}] */
function priceTiers(html) {
  const match = html.match(/"currentPricesWithOnePiece"\s*:\s*(\[[^\]]*\])/);
  if (!match) return [];
  try {
    const list = JSON.parse(match[1]);
    return list
      .map((item) => ({ price: Number(item.price), beginAmount: Number(item.beginAmount) }))
      .filter((item) => Number.isFinite(item.price) && item.price > 0);
  } catch {
    return [];
  }
}

/** 商品属性：页面上是一串 {"name":"型号","value":"DL209-2M80-V1","show":false} */
function attributes(html) {
  const out = [];
  const seen = new Set();
  const re = /\{"name":"([^"]{1,24})","value":"([^"]{0,80})"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const label = decodeEntities(match[1]).trim();
    const value = decodeEntities(match[2]).trim();
    if (!label || !value || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, value });
  }
  return out;
}

function soldCount(html) {
  const direct = jsonNumber(html, "saledCount");
  const text = jsonString(html, "saledCountStr");
  const scroll = html.match(/"prefix":"已售","text":"([^"]+)"/);
  return { count: direct ?? 0, text: text || (scroll ? scroll[1] : "") };
}

/**
 * 解析一条 1688 商品详情页。导出是为了单测。
 * @returns {{title:string, company:string, shopUrl:string, price:number, tiers:Array, sold:number, soldText:string, unit:string, attrs:Array, blocked:boolean, text:string}}
 */
export function parseOfferHtml(html, id = "") {
  const blocked = isBlockedHtml(html);
  if (blocked) {
    return { blocked: true, title: "", company: "", shopUrl: "", price: 0, tiers: [], sold: 0, soldText: "", unit: "", attrs: [], text: "" };
  }
  const title = jsonString(html, "offerTitle") || jsonString(html, "subject") || stripTags((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "");
  const company = jsonString(html, "companyName") || jsonString(html, "sellerLoginId");
  const shopUrl = jsonString(html, "winportUrl");
  const price = Number(jsonString(html, "price")) || Number((html.match(/"price"\s*:\s*"?([0-9.]+)"?/) || [])[1]) || 0;
  const tiers = priceTiers(html);
  const sold = soldCount(html);
  const unit = jsonString(html, "offerUnit") || jsonString(html, "unit");
  const attrs = attributes(html);

  const lines = [];
  if (title) lines.push(`【商品标题】${title}`);
  if (company) lines.push(`【厂家 / 店铺】${company}`);
  if (price) {
    const tierText = tiers.length
      ? `（${tiers.map((tier) => `${tier.beginAmount} 件 ¥${tier.price}`).join("；")}）`
      : "";
    lines.push(`【批发价】¥${price}${unit ? ` / ${unit}` : ""}${tierText}`);
  }
  if (sold.count || sold.text) lines.push(`【已售】${sold.text || sold.count}${unit ? ` ${unit}` : ""}`);
  if (attrs.length) {
    lines.push("【商品属性】");
    for (const attr of attrs.slice(0, 20)) lines.push(`- ${attr.label}：${attr.value}`);
  }
  if (id) lines.push(`【商品链接】${OFFER_URL(id)}`);

  const attrValue = (...labels) => {
    for (const label of labels) {
      const hit = attrs.find((attr) => attr.label === label);
      const value = hit?.value?.trim() ?? "";
      if (value && !/^(其他|其它|无|none|-)$/i.test(value)) return value;
    }
    return "";
  };
  const soldValue = sold.count || parseSaleText(sold.text);

  return {
    blocked: false,
    title,
    company,
    shopUrl,
    price: price || tiers[0]?.price || 0,
    tiers,
    sold: soldValue,
    soldText: sold.text,
    unit,
    attrs,
    manufacturer: attrValue("品牌", "厂家", "生产厂家") || company,
    model: attrValue("型号", "货号", "产品型号"),
    monthlySales: soldValue,
    params: attrs.map((attr) => ({ label: attr.label, value: attr.value })),
    text: lines.join("\n"),
  };
}

function parseSaleText(text) {
  const match = String(text).replace(/,/g, "").match(/(\d+(?:\.\d+)?)(万)?/);
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2] ? Math.round(value * 10_000) : Math.round(value);
}

export function isBlockedHtml(html) {
  return /_____tmd_____|x5secdata|punish\?x5secdata|滑动验证/.test(html);
}

/** 解析 DuckDuckGo HTML 结果里的 1688 商品链接。导出是为了单测。 */
export function parseSearchResults(html) {
  const results = [];
  const seen = new Set();
  const anchors = html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g);
  for (const anchor of anchors) {
    const href = decodeEntities(anchor[1]);
    const text = stripTags(anchor[2]);
    const target = extractTargetUrl(href);
    if (!target) continue;
    const id = (target.match(/1688\.com\/(?:offer\/)?(\d{10,16})\.html/) || [])[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    results.push({ id, title: text, url: OFFER_URL(id) });
  }
  return results;
}

function extractTargetUrl(href) {
  if (/1688\.com/.test(href)) return href;
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

export function createSource1688(options = {}) {
  const delayMs = Math.max(500, Number(options.delayMs) || 3500);
  const limit = Math.max(1, Number(options.limit) || 4);
  const retries = Math.max(0, Number(options.retries ?? 2));
  const cookie = String(options.cookie || "").trim();
  const direct = options.direct !== false;
  const seeds = options.seeds && typeof options.seeds === "object" ? options.seeds : {};

  function seedIdsFor(partType) {
    const raw = seeds[partType.code] ?? seeds[partType.name] ?? [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list
      .map((item) => String(typeof item === "object" && item ? item.url ?? "" : item).match(/(\d{10,16})/)?.[1] || "")
      .filter(Boolean)
      .slice(0, limit);
  }

  const cache = new Map();
  let blockedStreak = 0;
  let lastRequestAt = 0;
  let jar = cookie;
  let warmed = false;

  function absorbCookies(response) {
    const list =
      typeof response.headers?.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : (response.setCookies ?? []);
    if (list.length === 0) return;
    const pairs = new Map(jar ? jar.split("; ").map((item) => [item.split("=")[0], item]) : []);
    for (const raw of list) {
      const pair = raw.split(";")[0].trim();
      const name = pair.split("=")[0];
      if (!name || !pair.includes("=")) continue;
      pairs.set(name, pair);
    }
    jar = [...pairs.values()].join("; ");
  }

  async function rawRequest(url, extraHeaders = {}) {
    const wait = Math.max(0, lastRequestAt + delayMs - Date.now());
    if (wait > 0) await sleep(wait + Math.floor(Math.random() * 400));
    lastRequestAt = Date.now();

    const headers = {
      "User-Agent": UA,
      "Accept-Language": "zh-CN,zh;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: "https://m.1688.com/",
      "Upgrade-Insecure-Requests": "1",
      "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      ...extraHeaders,
    };
    if (jar) headers.Cookie = jar;
    const is1688 = /(^|\.)1688\.com$/.test(new URL(url).hostname);
    if (direct && is1688) {
      const result = await getDirect(url, headers);
      absorbCookies(result);
      return { status: result.status, html: result.html };
    }
    const response = await fetch(url, { headers, redirect: "follow" });
    absorbCookies(response);
    const html = await response.text();
    return { status: response.status, html };
  }

  /** 先访问一次首页拿到匿名 Cookie（cna / __cn_logon__ 等），再抓详情，风控明显更松。 */
  async function warmup() {
    if (warmed || cookie) return;
    warmed = true;
    try {
      await rawRequest("https://m.1688.com/");
    } catch {
      /* 预热失败不影响后续 */
    }
  }

  async function request(url, extraHeaders) {
    await warmup();
    return rawRequest(url, extraHeaders);
  }

  async function fetchOffer(id) {
    if (cache.has(id)) return cache.get(id);
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const { html } = await request(MOBILE_OFFER_URL(id));
      if (!isBlockedHtml(html)) {
        blockedStreak = 0;
        const parsed = parseOfferHtml(html, id);
        cache.set(id, parsed);
        return parsed;
      }
      await sleep(Math.max(delayMs, 6000) * (attempt + 2));
    }
    blockedStreak += 1;
    if (blockedStreak >= 3) {
      throw new SourceBlockedError(
        "1688 连续 3 个商品都返回滑块验证页（匿名请求被限流）。可依次尝试：" +
          "① 把 MARKET_1688_DELAY_MS 调到 8000 以上并隔一段时间再跑；" +
          "② 在 market-config.env 里配置 MARKET_1688_COOKIE（浏览器登录 1688 后复制的整串 Cookie）。",
      );
    }
    return null;
  }

  async function searchDuckDuckGo(query) {
    const engines = [
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=cn-zh`,
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    ];
    let lastError = null;
    for (const url of engines) {
      try {
        const { html } = await request(url);
        const hits = parseSearchResults(html);
        if (hits.length) return hits;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  /** 带登录 Cookie 时，1688 自家搜索页可用；没有 Cookie 会 302 到登录页。 */
  async function search1688(keywords) {
    if (!cookie) return [];
    const url = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keywords)}`;
    const { html } = await request(url);
    if (/login\.1688\.com|请登录/.test(html)) return [];
    return parseSearchResults(html);
  }

  return {
    name: "1688",
    label: "1688（阿里巴巴批发）",

    /**
     * 搜索顺序：人工种子（最稳） → 1688 自家搜索（需 Cookie） → DuckDuckGo 站内检索。
     * 三条都拿不到时返回空数组，让管线明确报「没有候选」，而不是编数据。
     */
    async search(partType) {
      const keywords = partType.name || partType.code || "";
      const seedIds = new Set(seedIdsFor(partType));
      const found = new Map();

      for (const id of seedIds) found.set(id, { id, title: "" });

      if (found.size < limit) {
        try {
          for (const item of await search1688(keywords)) {
            if (!found.has(item.id)) found.set(item.id, item);
            if (found.size >= limit) break;
          }
        } catch (error) {
          console.warn(`  [1688] 站内搜索不可用：${error.message}`);
        }
      }

      if (found.size < limit) {
        try {
          for (const item of await searchDuckDuckGo(`site:detail.1688.com ${keywords}`)) {
            if (!found.has(item.id)) found.set(item.id, item);
            if (found.size >= limit) break;
          }
        } catch (error) {
          console.warn(`  [1688] DuckDuckGo 检索失败：${error.message}`);
        }
      }

      if (found.size === 0) {
        throw new Error(
          `1688 没有找到「${keywords}」(${partType.code}) 的候选。站内搜索走不通（结果页是 JS 渲染的空壳，` +
            `浏览器渲染会撞验证码），发现商品只能靠种子：在 backend/seeds/1688-seeds.json 里加一行，例如 ` +
            `{"${partType.code}": ["https://detail.1688.com/offer/1234567890.html"]}`,
        );
      }

      const listings = [];
      for (const item of [...found.values()].slice(0, limit)) {
        const detail = await fetchOffer(item.id);
        if (!detail || detail.blocked) continue;
        listings.push({
          id: item.id,
          title: detail.title || item.title || item.id,
          url: OFFER_URL(item.id),
          shop: detail.company || "",
          sales: detail.sold || 0,
          listPrice: detail.price || 0,
          detail,
        });
      }
      return listings;
    },

    async detail(listing) {
      if (listing?.detail) return listing.detail;
      const parsed = await fetchOffer(listing.id);
      if (!parsed || parsed.blocked) {
        return {
          text: `【商品标题】${listing.title}\n（详情页被 1688 风控拦截，只能用标题判断）`,
          manufacturer: "",
          model: "",
          price: listing.listPrice || 0,
          monthlySales: listing.sales || 0,
          params: [],
        };
      }
      return parsed;
    },
  };
}

/**
 * 单次探测：验证「Cookie / 直连」当前是否可用。只发一个请求，不重试、不预热。
 * @returns {{blocked:boolean, status:number, length:number, loginWall:boolean, parsed:object|null, cookiePresent:boolean}}
 */
export async function probeOffer(id, options = {}) {
  const cookie = String(options.cookie || "").trim();
  const direct = options.direct !== false;
  const url = MOBILE_OFFER_URL(id);
  const headers = {
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9",
    Accept: "text/html,application/xhtml+xml",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: "https://m.1688.com/",
  };
  if (cookie) headers.Cookie = cookie;

  let status = 0;
  let html = "";
  if (direct) {
    const result = await getDirect(url, headers);
    status = result.status;
    html = result.html;
  } else {
    const response = await fetch(url, { headers, redirect: "follow" });
    status = response.status;
    html = await response.text();
  }

  const blocked = isBlockedHtml(html);
  return {
    blocked,
    status,
    length: html.length,
    loginWall: /login\.1688\.com|请登录/.test(html),
    parsed: blocked ? null : parseOfferHtml(html, id),
    cookiePresent: Boolean(cookie),
  };
}
