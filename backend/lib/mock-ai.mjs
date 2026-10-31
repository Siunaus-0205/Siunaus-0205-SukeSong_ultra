/**
 * 本地模拟 AI：没有 API Key 时也能把整条链路跑通。
 *
 * 模拟源的数据里已经带了 structured 字段（厂家/型号/参数），
 * 这里只负责按契约输出，行为与联网模式保持一致。
 */

function mode(values) {
  const counts = new Map();
  for (const value of values) {
    const key = String(value || "").trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = "";
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function slugFor(model) {
  const text = String(model || "").normalize("NFKC");
  const digits = (text.match(/\d+/g) || []).join("").slice(-3);
  if (digits) return `m${digits}`;
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 6);
  return ascii.length >= 2 ? `m${ascii}` : "m01";
}

function uniqueParams(rows) {
  const seen = new Map();
  for (const row of rows) {
    for (const param of row.params || []) {
      const label = String(param.label || "").trim();
      const value = String(param.value || "").trim();
      if (!label || !value) continue;
      if (!seen.has(label)) seen.set(label, new Set());
      seen.get(label).add(value);
    }
  }
  const result = [];
  for (const [label, values] of seen) {
    result.push({ label: label.slice(0, 12), value: [...values].join(" / ").slice(0, 60) });
    if (result.length >= 6) break;
  }
  return result.length > 0 ? result : [{ label: "参数", value: "详见商品详情页" }];
}

export function mockJudgeType({ partType, detail }) {
  const belongs = detail.simulatedType === partType.code;
  return {
    partTypeCode: partType.code,
    belongs,
    confidence: belongs ? 0.95 : 0.9,
    reason: belongs
      ? `详情页结构与 ${partType.name} 的典型参数一致。`
      : `详情页描述的是 ${detail.simulatedTypeName || "其他品类"}，不是 ${partType.name}。`,
  };
}

export function mockExtractListing({ listing, detail }) {
  return {
    manufacturer: detail.manufacturer,
    model: detail.model,
    price: detail.price,
    monthlySales: detail.monthlySales ?? listing.sales,
    params: (detail.params || []).slice(0, 8),
    spec: (detail.spec || "").slice(0, 200),
    confidence: 0.94,
  };
}

export function mockMergePart({ partType, rows }) {
  const manufacturer = mode(rows.map((row) => row.manufacturer));
  const model = mode(rows.map((row) => row.model));
  return {
    manufacturer,
    model,
    displayName: `${partType.name} · ${model}`.slice(0, 60),
    codeSuffix: slugFor(model),
    params: uniqueParams(rows),
    confidence: 0.93,
    reason: `同厂家同型号共 ${rows.length} 条在售商品，参数一致。`,
  };
}

export function mockSameProduct({ existing, group }) {
  const existingParams = new Map(
    (existing.params || []).map((param) => [param.label, String(param.value).trim()]),
  );
  let compared = 0;
  let matched = 0;
  for (const param of group.params || []) {
    const expected = existingParams.get(param.label);
    if (!expected) continue;
    compared += 1;
    const actual = String(param.value).trim();
    if (expected === actual || expected.includes(actual) || actual.includes(expected)) matched += 1;
  }
  const same = compared === 0 ? true : matched / compared >= 0.5;
  return {
    same,
    confidence: compared === 0 ? 0.7 : Math.min(0.98, 0.6 + (matched / compared) * 0.35),
    reason:
      compared === 0
        ? "现有型号没有可对比的参数，按厂家与型号一致暂判同款。"
        : `对比 ${compared} 项参数，${matched} 项一致。`,
    paramDelta: compared === 0 ? "" : `${matched}/${compared} 项一致`,
  };
}
