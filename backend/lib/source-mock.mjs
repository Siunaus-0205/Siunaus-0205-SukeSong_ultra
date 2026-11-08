/**
 * 模拟平台数据源：在没有淘宝 / 抖音 API 时把整条链路跑通。
 *
 * 数据是确定性的（按零件类型做种子），便于测试与复现：
 *   - 每个类型 3 个厂家 × 4 条在售商品；
 *   - 混入 3 条"标题像、详情不是"的干扰项；
 *   - 每个类型有 1 条明显异常高价，用来验证剔除；
 *   - h3-cam-01 的第一组整体抬价 45%，用来保证每轮至少有一条数据需要人工审核。
 */

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, list) {
  return list[Math.floor(random() * list.length) % list.length];
}

const MAKERS = ["深瑞精工", "凌越智造", "恒川机电", "拓界科技", "恒锐精密", "云衡动力"];

/**
 * 故意留一条"价格异动"，用来演示「同一厂家 + 同一型号，但价格变了」这条分支：
 * 命中的那一组整体抬价 45%，超过 MARKET_SAME_PRICE_TOLERANCE（默认 30%），
 * 流水线不会自动改价，而是把这一组送进人工审核队列。
 * 只动一个类型的第一组（h3-cam-01 · 凌越智造 H3CAM01-105），其余模拟数据完全不变。
 */
const PRICE_SHOCK = { partTypeCode: "h3-cam-01", group: 0, factor: 1.45 };

function makeListing({ partType, index, manufacturer, model, price, sales, variant, outlier }) {
  const seed = hash(`${partType.code}-${index}`);
  const random = prng(seed);
  const shops = ["旗舰店", "工厂直营店", "官方企业店", "精密制造店"];
  const params = [
    { label: "材质", value: variant.material },
    { label: "关键规格", value: variant.spec },
    { label: "产地", value: pick(random, ["深圳", "东莞", "苏州", "宁波"]) },
  ];
  if (partType.code.includes("pwr") || partType.code.includes("ctl")) {
    params.push({ label: "电气参数", value: pick(random, ["5V / 2A", "7.4V / 3A", "12V / 1.5A"]) });
  }
  const title = `${manufacturer} ${partType.name} ${model} 厂家直销`;
  const detailText = [
    "【商品详情】",
    `品牌 / 厂家：${manufacturer}`,
    `厂家型号：${model}`,
    `价格：¥${price.toFixed(2)}`,
    `月销：${sales}`,
    "参数：",
    ...params.map((param) => `- ${param.label}：${param.value}`),
    "发货地：广东深圳；质保：12 个月。",
  ].join("\n");

  return {
    id: `${partType.code}-${index}`,
    title,
    url: `https://mock.market.local/item/${partType.code}/${index}`,
    shop: `${manufacturer}${pick(random, shops)}`,
    sales,
    listPrice: price,
    detail: {
      text: detailText,
      manufacturer,
      model,
      price,
      monthlySales: sales,
      params,
      spec: `${variant.spec} · ${variant.material}`,
      simulatedType: partType.code,
      simulatedTypeName: partType.name,
      outlier: Boolean(outlier),
    },
  };
}

function makeDecoy(partType, index) {
  const title = `${partType.name} 通用配件 特价`;
  return {
    id: `${partType.code}-x${index}`,
    title,
    url: `https://mock.market.local/item/${partType.code}/x${index}`,
    shop: "杂货铺",
    sales: 8000 + index * 100,
    listPrice: 19.9,
    detail: {
      text: "【商品详情】\n这是一款通用小配件，不适用于该零件类型。\n价格：¥19.90\n月销：8000+",
      price: 19.9,
      monthlySales: 8000 + index * 100,
      params: [{ label: "类型", value: "通用配件" }],
      simulatedType: "other",
      simulatedTypeName: "通用配件",
    },
  };
}

export function createMockSource() {
  return {
    name: "mock",
    label: "模拟平台",

    /**
     * @param {object} partType 表1 的零件类型
     * @param {object} context  { baselinePrice, baselineSpec, baselineMaterial }
     */
    async search(partType, context = {}) {
      const random = prng(hash(partType.code));
      const base = Number(context.baselinePrice) || 120;
      const spec = context.baselineSpec || partType.spec || "工业级";
      const material = context.baselineMaterial || partType.material || "铝合金";
      const makers = [];
      const makerPool = [...MAKERS];
      for (let slot = 0; slot < 3; slot += 1) {
        makers.push(makerPool.splice(Math.floor(random() * makerPool.length), 1)[0]);
      }
      const listings = [];
      let index = 1;

      for (let group = 0; group < 3; group += 1) {
        const manufacturer = makers[group];
        const model = `${partType.code.toUpperCase().replace(/-/g, "")}-${100 + group * 7 + (hash(manufacturer) % 20)}`;
        const variant = { material, spec };
        const shock =
          partType.code === PRICE_SHOCK.partTypeCode && group === PRICE_SHOCK.group
            ? PRICE_SHOCK.factor
            : 1;
        const groupPrice = base * [0.98, 1.06, 1.12][group] * shock;
        for (let item = 0; item < 4; item += 1) {
          const sales = Math.round(28000 / (index * 0.85 + 0.4));
          const jitter = 1 + (random() - 0.5) * 0.06;
          const price = Math.max(1, Number((groupPrice * jitter).toFixed(2)));
          listings.push(
            makeListing({ partType, index, manufacturer, model, price, sales, variant }),
          );
          index += 1;
        }
        if (group === 0) {
          // 同一厂家同一型号的异常高价：验证"剔除后重算中位价"
          listings.push(
            makeListing({
              partType,
              index,
              manufacturer,
              model,
              price: Number((groupPrice * 2.6).toFixed(2)),
              sales: 6400,
              variant,
              outlier: true,
            }),
          );
          index += 1;
        }
      }

      for (let decoy = 1; decoy <= 3; decoy += 1) listings.push(makeDecoy(partType, decoy));
      return listings;
    },

    async detail(listing) {
      return listing.detail;
    },
  };
}
