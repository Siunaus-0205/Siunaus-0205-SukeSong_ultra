/**
 * 商品链接的唯一规则（写入、审核、校验共用）：
 *   - 每个产品 1 条 primary=true 主链接 + 至多 3 条 primary=false 备选链接；
 *   - 同一产品的链接地址不能重复（按归一化后的 URL 判断）；
 *   - 只接受 http(s) 地址。
 */

export const MAX_SECONDARY_LINKS = 3;

const TRACKING_PARAM = /^(utm_|spm|scm|share|from|source|ref|pvid|abbucket|ali_|track)/i;

/** 链接归一化：去锚点、营销参数和末尾斜杠，主机名小写。返回值即"是否重复"的判据。 */
export function normalizeLinkUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    const query = url.searchParams.toString();
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}${query ? `?${query}` : ""}`;
  } catch {
    return "";
  }
}

/** 统一链接表：去重、只保留 1 条 true、最多 3 条 false；没有 true 时第一条提升为 true。 */
export function normalizeLinks(list, { maxSecondary = MAX_SECONDARY_LINKS, preferPrimary = "" } = {}) {
  const source = Array.isArray(list) ? list : [];
  const seen = new Set();
  const rows = [];
  for (const entry of source) {
    const item = typeof entry === "string" ? { url: entry } : entry;
    if (!item || typeof item !== "object") continue;
    const url = normalizeLinkUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    rows.push({
      url,
      shop: String(item.shop || "").slice(0, 60),
      price: Number.isFinite(Number(item.price)) ? Number(item.price) : null,
      monthlySales: Number.isFinite(Number(item.monthlySales)) ? Number(item.monthlySales) : null,
      primary: item.primary === true,
      capturedAt: item.capturedAt || null,
    });
  }
  if (rows.length === 0) return [];

  const wanted = normalizeLinkUrl(preferPrimary);
  let primaryIndex = wanted ? rows.findIndex((row) => row.url === wanted) : -1;
  if (primaryIndex < 0) primaryIndex = rows.findIndex((row) => row.primary);
  if (primaryIndex < 0) primaryIndex = 0;

  const result = [{ ...rows[primaryIndex], primary: true }];
  for (const row of rows) {
    if (result.length >= maxSecondary + 1) break;
    if (row === rows[primaryIndex]) continue;
    result.push({ ...row, primary: false });
  }
  return result;
}

/** 合并新旧链接：现有主链接仍是主链接，新抓到的排在前面，旧备选兜底。 */
export function mergeLinks(existing, incoming) {
  const current = normalizeLinks(existing);
  const primary = current.find((link) => link.primary);
  const ordered = [];
  if (primary) ordered.push(primary);
  ordered.push(...normalizeLinks(incoming));
  for (const link of current) {
    if (!link.primary) ordered.push(link);
  }
  return normalizeLinks(ordered, { preferPrimary: primary?.url || "" });
}

/** 只取主链接（审核页"当前产品标记为 true 的链接"）。 */
export function primaryLinks(list) {
  return normalizeLinks(list).filter((link) => link.primary);
}
