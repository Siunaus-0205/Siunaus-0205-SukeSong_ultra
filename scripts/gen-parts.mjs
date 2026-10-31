/**
 * 生成演示用零件库 public/data/h3-parts.json。
 *
 * 口径（与第二页「用户自配 / 方案对比」一致）：
 *   - 每个零件类型 10 个型号 = 基础四款（标准 / 轻量 / 增强 / 旗舰）
 *     + 两个厂家各 3 款（模拟平台在售，带厂家、型号、链接）；
 *   - 10 个型号用同一套字段：厂家 / 型号 / 核心参数 / 性能分 / 单价 / 重量 /
 *     交期 / 风险，界面不再区分「基础款」和「抓取款」的展示格式；
 *   - 每个类型挑 3 个核心参数衡量性能，按绝对值区间归一化后加权成 0–100 的
 *     性能分（越高越好），存进 variant.performance；coreParams 存参数值本身；
 *   - 基础四款的单价 / 重量 / 交期 / 风险沿用改版前的数，保证需求约束与演示
 *     故事不变；厂家款按「便宜但性能一般 / 贵但性能好」两档生成。
 *
 * 全部数据确定性生成（按类型 code 做种子），重跑结果一致。
 *
 * 用法：node atlas/scripts/gen-parts.mjs [--write]
 *   不带 --write 只打印统计，便于先看差异。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PARTS_FILE = join(HERE, "../pages/public/data/h3-parts.json");

/* ------------------------------------------------------------------ */
/* 种子与工具                                                          */
/* ------------------------------------------------------------------ */

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** 0–1 的确定性抖动，避免同一档位的每个参数都长得一模一样。 */
function jitter(seedText, spread) {
  return ((hash(seedText) % 1000) / 1000 - 0.5) * 2 * spread;
}

const round = (value, digits) => Number(Number(value).toFixed(digits));

/* ------------------------------------------------------------------ */
/* 核心参数（衡量性能）                                                */
/* ------------------------------------------------------------------ */

// [标签, 单位, 区间下界, 区间上界, 方向(1 越大越好 / -1 越小越好), 权重, 小数位]
const PERF = {
  "h3-cam-01": [
    ["分辨率", "MP", 8, 40, 1, 0.4, 1],
    ["帧率", "fps", 30, 120, 1, 0.35, 0],
    ["低照度", "lx", 0.001, 0.05, -1, 0.25, 4],
  ],
  "h3-cam-02": [
    ["视场角", "°", 70, 140, 1, 0.35, 0],
    ["光圈", "F", 1.6, 4.0, -1, 0.35, 1],
    ["畸变", "%", 0.5, 6.0, -1, 0.3, 2],
  ],
  "h3-cam-03": [
    ["MIPI 通道", "lane", 4, 8, 1, 0.3, 0],
    ["带宽", "Gbps", 2.4, 6.0, 1, 0.4, 1],
    ["读出噪声", "mV", 2, 8, -1, 0.3, 1],
  ],
  "h3-cam-04": [
    ["导热系数", "W/mK", 120, 220, 1, 0.4, 0],
    ["热阻", "°C/W", 0.8, 2.5, -1, 0.4, 2],
    ["平面度", "mm", 0.01, 0.05, -1, 0.2, 3],
  ],
  "h3-pit-01": [
    ["峰值扭矩", "N·m", 0.35, 1.2, 1, 0.4, 2],
    ["齿槽转矩", "mN·m", 3, 12, -1, 0.3, 1],
    ["效率", "%", 72, 88, 1, 0.3, 0],
  ],
  "h3-pit-02": [
    ["屈服强度", "MPa", 220, 500, 1, 0.35, 0],
    ["抗弯刚度", "kN/mm", 8, 20, 1, 0.35, 1],
    ["疲劳寿命", "万次", 50, 500, 1, 0.3, 0],
  ],
  "h3-pit-03": [
    ["零偏稳定性", "°/h", 0.6, 3.0, -1, 0.4, 2],
    ["采样率", "kHz", 1, 8, 1, 0.3, 0],
    ["噪声密度", "°/s/√Hz", 0.004, 0.02, -1, 0.3, 3],
  ],
  "h3-pit-04": [
    ["额定动载", "kN", 1.2, 4.5, 1, 0.35, 2],
    ["游隙", "μm", 3, 15, -1, 0.3, 0],
    ["寿命", "小时", 2000, 12000, 1, 0.35, 0],
  ],
  "h3-rol-01": [
    ["峰值扭矩", "N·m", 0.3, 1.1, 1, 0.4, 2],
    ["齿槽转矩", "mN·m", 3, 14, -1, 0.3, 1],
    ["效率", "%", 70, 88, 1, 0.3, 0],
  ],
  "h3-rol-02": [
    ["屈服强度", "MPa", 220, 480, 1, 0.35, 0],
    ["抗弯刚度", "kN/mm", 8, 19, 1, 0.35, 1],
    ["疲劳寿命", "万次", 50, 450, 1, 0.3, 0],
  ],
  "h3-rol-03": [
    ["接触电阻", "mΩ", 15, 80, -1, 0.4, 0],
    ["通道数", "Pin", 8, 24, 1, 0.3, 0],
    ["弯折寿命", "万次", 100, 1000, 1, 0.3, 0],
  ],
  "h3-rol-04": [
    ["冲击耐受", "g", 50, 200, 1, 0.35, 0],
    ["定位重复性", "μm", 5, 30, -1, 0.35, 0],
    ["耐磨寿命", "万次", 20, 200, 1, 0.3, 0],
  ],
  "h3-yaw-01": [
    ["峰值扭矩", "N·m", 0.4, 1.3, 1, 0.4, 2],
    ["齿槽转矩", "mN·m", 3, 14, -1, 0.3, 1],
    ["效率", "%", 70, 88, 1, 0.3, 0],
  ],
  "h3-yaw-02": [
    ["屈服强度", "MPa", 220, 520, 1, 0.35, 0],
    ["抗弯刚度", "kN/mm", 8, 20, 1, 0.35, 1],
    ["疲劳寿命", "万次", 50, 500, 1, 0.3, 0],
  ],
  "h3-yaw-03": [
    ["分辨率", "bit", 12, 20, 1, 0.35, 0],
    ["角度误差", "arcsec", 8, 60, -1, 0.35, 0],
    ["响应延迟", "μs", 2, 20, -1, 0.3, 0],
  ],
  "h3-yaw-04": [
    ["抗拉强度", "MPa", 800, 1400, 1, 0.35, 0],
    ["预紧一致性", "%", 70, 95, 1, 0.3, 0],
    ["循环寿命", "万次", 10, 100, 1, 0.35, 0],
  ],
  "h3-hnd-01": [
    ["落球冲击", "J", 3.0, 9.0, 1, 0.35, 1],
    ["耐温", "°C", 70, 110, 1, 0.3, 0],
    ["表面硬度", "H", 2, 9, 1, 0.35, 0],
  ],
  "h3-hnd-02": [
    ["落球冲击", "J", 3.0, 9.0, 1, 0.35, 1],
    ["耐温", "°C", 70, 110, 1, 0.3, 0],
    ["表面硬度", "H", 2, 9, 1, 0.35, 0],
  ],
  "h3-hnd-03": [
    ["摩擦系数", "", 0.5, 1.1, 1, 0.35, 2],
    ["回弹率", "%", 30, 70, 1, 0.3, 0],
    ["耐磨", "万次", 5, 40, 1, 0.35, 0],
  ],
  "h3-hnd-04": [
    ["承载", "kg", 1.5, 5.0, 1, 0.35, 1],
    ["装拆时间", "s", 2, 8, -1, 0.3, 1],
    ["重复定位", "mm", 0.03, 0.3, -1, 0.35, 2],
  ],
  "h3-ctl-01": [
    ["主频", "MHz", 240, 600, 1, 0.35, 0],
    ["内存", "MB", 8, 64, 1, 0.3, 0],
    ["功耗", "W", 0.7, 2.2, -1, 0.35, 2],
  ],
  "h3-ctl-02": [
    ["驱动电流", "A", 2, 8, 1, 0.4, 1],
    ["环路频率", "kHz", 20, 50, 1, 0.3, 0],
    ["温升", "°C", 18, 45, -1, 0.3, 0],
  ],
  "h3-ctl-03": [
    ["摇杆精度", "%", 0.5, 3.0, -1, 0.4, 1],
    ["采样率", "Hz", 100, 1000, 1, 0.3, 0],
    ["按键寿命", "万次", 20, 200, 1, 0.3, 0],
  ],
  "h3-ctl-04": [
    ["吞吐", "Mbps", 0.8, 3.0, 1, 0.35, 1],
    ["传输距离", "m", 10, 80, 1, 0.35, 0],
    ["端到端延迟", "ms", 8, 40, -1, 0.3, 0],
  ],
  "h3-pwr-01": [
    ["容量", "mAh", 1500, 3500, 1, 0.4, 0],
    ["循环寿命", "次", 300, 1200, 1, 0.35, 0],
    ["内阻", "mΩ", 45, 120, -1, 0.25, 0],
  ],
  "h3-pwr-02": [
    ["输出电流", "A", 3, 6, 1, 0.4, 1],
    ["转换效率", "%", 85, 96, 1, 0.35, 0],
    ["静态功耗", "mA", 0.2, 1.5, -1, 0.25, 1],
  ],
  "h3-pwr-03": [
    ["功率", "W", 15, 100, 1, 0.4, 0],
    ["插拔寿命", "万次", 1, 10, 1, 0.3, 0],
    ["接触电阻", "mΩ", 8, 30, -1, 0.3, 0],
  ],
  "h3-pwr-04": [
    ["载流", "A", 3, 10, 1, 0.4, 0],
    ["耐温", "°C", 80, 150, 1, 0.3, 0],
    ["压降", "mV", 30, 120, -1, 0.3, 0],
  ],
};

/* ------------------------------------------------------------------ */
/* 型号档位                                                            */
/* ------------------------------------------------------------------ */

/** 10 个型号的性能档位（0–1，越高越好）；顺序即 variants 顺序。 */
const GRADES = {
  std: 0.45,
  lite: 0.38,
  plus: 0.66,
  pro: 0.86,
  a1: 0.34,
  a2: 0.44,
  a3: 0.53,
  b1: 0.6,
  b2: 0.72,
  b3: 0.82,
};

const MAKERS = ["深瑞精工", "凌越智造", "恒川机电", "拓界科技", "恒锐精密", "云衡动力"];
const SHOP_SUFFIX = ["旗舰店", "工厂直营店", "官方企业店", "精密制造店"];
const ORIGINS = ["深圳", "东莞", "苏州", "宁波"];

/** 两个厂家各 3 款的商务档位：A 便宜、B 贵但规格高。 */
const VENDOR_PLAN = {
  a: {
    grades: ["a1", "a2", "a3"],
    priceFactor: [0.9, 0.95, 1.0],
    weightFactor: [1.0, 1.03, 1.06],
    leadOffset: [2, 1, 0],
    risks: ["中", "中", "低"],
  },
  b: {
    grades: ["b1", "b2", "b3"],
    priceFactor: [1.05, 1.14, 1.24],
    weightFactor: [0.95, 0.99, 1.04],
    leadOffset: [4, 2, 1],
    risks: ["低", "中", "中"],
  },
};

const MONEY = (value) => Math.round(value * 100) / 100;
const GRAMS = (value) => Math.round(value * 10) / 10;

/** 核心参数：按档位 g 在绝对区间里取值，再算加权性能分。 */
function coreParams(code, grade, seedId) {
  const spec = PERF[code];
  const rows = [];
  let performance = 0;
  spec.forEach(([label, unit, lo, hi, dir, weight, digits], index) => {
    const g = Math.max(0.02, Math.min(1, grade + jitter(`${seedId}-${index}`, 0.035)));
    const value = dir > 0 ? lo + g * (hi - lo) : hi - g * (hi - lo);
    const rounded = round(value, digits);
    rows.push({
      label,
      value: `${rounded}${unit ? ` ${unit}` : ""}`,
      score: Math.round(g * 1000) / 10,
    });
    performance += g * weight * 100;
  });
  return { rows, performance: Math.round(performance * 10) / 10 };
}

/* ------------------------------------------------------------------ */
/* 生成                                                                */
/* ------------------------------------------------------------------ */

const doc = JSON.parse(readFileSync(PARTS_FILE, "utf8"));
const oldParts = new Map();
for (const module of doc.modules) for (const part of module.parts) oldParts.set(part.code, part);

const stats = { types: 0, variants: 0, base: 0, vendor: 0 };

for (const module of doc.modules) {
  for (const part of module.parts) {
    const previous = oldParts.get(part.code);
    const baseTiers = ["std", "lite", "plus", "pro"].map((tierKey) =>
      previous.variants.find((variant) => variant.tierKey === tierKey),
    );
    if (baseTiers.some((variant) => !variant)) throw new Error(`${part.code} 缺少基础四款`);

    const seed = hash(part.code);
    const vendorA = MAKERS[seed % MAKERS.length];
    const vendorB = MAKERS[(seed * 7 + 3) % MAKERS.length];
    const makerB = vendorB === vendorA ? MAKERS[(seed * 7 + 4) % MAKERS.length] : vendorB;
    // 基线四款挂在「基线供应商」名下；与两个对比厂家区分开，避免同名不同款。
    const baseMaker = MAKERS.find((maker) => maker !== vendorA && maker !== makerB) || MAKERS[0];
    const originA = ORIGINS[seed % ORIGINS.length];
    const originB = ORIGINS[(seed + 2) % ORIGINS.length];
    const codeNumber = part.code.toUpperCase().replace(/-/g, "");

    const variants = [];

    // 基础四款：沿用原来的价格 / 重量 / 交期 / 风险，补上厂家、型号、核心参数与性能分。
    baseTiers.forEach((tier, index) => {
      const key = ["std", "lite", "plus", "pro"][index];
      const { rows, performance } = coreParams(part.code, GRADES[key], `${part.code}-${key}`);
      const model = `${codeNumber}-${["S", "L", "P", "X"][index]}`;
      variants.push({
        id: tier.id,
        tierKey: tier.tierKey,
        tier: tier.tier,
        name: `${part.name} · ${tier.tier}`,
        manufacturer: baseMaker,
        model,
        price: tier.price,
        weight: tier.weight,
        leadTime: tier.leadTime,
        risk: tier.risk,
        material: tier.material,
        spec: tier.spec,
        owner: tier.owner,
        description: tier.description,
        coreParams: rows,
        performance,
        source: "自有基线",
      });
      stats.base += 1;
    });

    // 两个厂家各 3 款：格式与模拟平台抓取的货品一致（厂家 / 型号 / 链接）。
    for (const [slot, plan] of Object.entries(VENDOR_PLAN)) {
      const maker = slot === "a" ? vendorA : makerB;
      const origin = slot === "a" ? originA : originB;
      plan.grades.forEach((gradeKey, index) => {
        const { rows, performance } = coreParams(
          part.code,
          GRADES[gradeKey],
          `${part.code}-${gradeKey}`,
        );
        const model = `${codeNumber}-${(slot === "a" ? 2 : 3) * 100 + index + 1}`;
        // 逐类型的商务条款抖动：不同零件的折扣不该一模一样，否则"全换最便宜那款"
        // 会变成机械解，推荐看起来就不像在做取舍。
        const priceJitter = 1 + jitter(`${part.code}-${slot}${index}-price`, 0.06);
        const weightJitter = 1 + jitter(`${part.code}-${slot}${index}-weight`, 0.03);
        const price = MONEY(baseTiers[0].price * plan.priceFactor[index] * priceJitter);
        const weight = GRAMS(baseTiers[0].weight * plan.weightFactor[index] * weightJitter);
        const leadTime = Number(baseTiers[0].leadTime) + plan.leadOffset[index];
        const links = [
          {
            url: `https://mock.market.local/item/${part.code}/${index + 1}`,
            shop: `${maker}${SHOP_SUFFIX[hash(`${model}-shop`) % SHOP_SUFFIX.length]}`,
            price,
            monthlySales: 3000 + (hash(`${model}-sales`) % 9000),
            primary: true,
            capturedAt: "2026-10-31T02:00:00.000Z",
          },
          {
            url: `https://mock.market.local/item/${part.code}/${index + 5}`,
            shop: `${maker}${SHOP_SUFFIX[(hash(model) + 1) % SHOP_SUFFIX.length]}`,
            price: MONEY(price * 0.99),
            monthlySales: 1200 + (hash(`${model}-s2`) % 6000),
            primary: false,
            capturedAt: "2026-10-31T02:00:00.000Z",
          },
          {
            url: `https://mock.market.local/item/${part.code}/${index + 9}`,
            shop: `${maker}${SHOP_SUFFIX[(hash(model) + 2) % SHOP_SUFFIX.length]}`,
            price: MONEY(price * 1.02),
            monthlySales: 800 + (hash(`${model}-s3`) % 4000),
            primary: false,
            capturedAt: "2026-10-31T02:00:00.000Z",
          },
        ];
        variants.push({
          id: `${part.code}-${slot}${index + 1}`,
          tierKey: "market",
          tier: "市场",
          name: `${part.name} · ${maker} ${model}`,
          manufacturer: maker,
          model,
          price,
          weight,
          leadTime,
          risk: plan.risks[index],
          material: baseTiers[0].material,
          spec: baseTiers[0].spec,
          owner: "市场抓取",
          origin,
          description: `来自模拟平台的在售商品：${maker} ${model}，价格取销量加权中位价。`,
          coreParams: rows,
          performance,
          source: "模拟平台",
          links,
          capturedAt: "2026-10-31T02:00:00.000Z",
          updatedAt: "2026-10-31T02:05:00.000Z",
        });
        stats.vendor += 1;
      });
    }

    if (variants.length !== 10) throw new Error(`${part.code} 生成了 ${variants.length} 个型号`);

    part.baselineVariantId = `${part.code}-std`;
    part.performanceBasis = {
      note: "核心参数按绝对区间归一化后加权成 0–100 的性能分（越高越好）。",
      params: PERF[part.code].map(([label, unit, lo, hi, dir, weight, digits]) => ({
        label,
        unit,
        min: lo,
        max: hi,
        direction: dir > 0 ? "higher" : "lower",
        weight,
        digits,
      })),
    };
    part.variants = variants;
    stats.types += 1;
    stats.variants += variants.length;
  }
}

doc.schemaVersion = "atlas.stage2-parts/v2";
doc.$comment =
  "第二页零件库。每个类型 10 个型号：基础四款（标准 / 轻量 / 增强 / 旗舰）+ 两个厂家各 3 款。" +
  "字段统一：厂家 / 型号 / 核心参数 / 性能分 / 单价 / 重量 / 交期 / 风险；" +
  "performance 为 0–100 性能分，coreParams 为挑出来衡量性能的核心参数。";
doc.tiers = [
  { key: "std", label: "标准", note: "沿用基线规格，成本与风险最低。" },
  { key: "lite", label: "轻量", note: "减重优先，单价与交期略增。" },
  { key: "plus", label: "增强", note: "性能提升，重量与成本上浮。" },
  { key: "pro", label: "旗舰", note: "规格拉满，成本与交期最高。" },
  { key: "market", label: "市场", note: "模拟平台在售的厂家型号，价格与性能由采集数据决定。" },
];
doc.units = { price: "CNY", weight: "g", leadTime: "day", performance: "0-100" };
doc.generatedBy = "atlas/scripts/gen-parts.mjs";

const text = `${JSON.stringify(doc, null, 2)}\n`;

console.log(
  [
    `类型 ${stats.types} · 型号 ${stats.variants}（基础 ${stats.base} + 厂家 ${stats.vendor}）`,
    `每个类型型号数：${[
      ...new Set(doc.modules.flatMap((m) => m.parts.map((p) => p.variants.length))),
    ].join(",")}`,
    `文件大小 ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`,
  ].join("\n"),
);

if (process.argv.includes("--write")) {
  writeFileSync(PARTS_FILE, text, "utf8");
  console.log("已写入", PARTS_FILE);
} else {
  console.log("（未写入，加 --write 才落盘）");
}
