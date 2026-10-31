"use strict";

/**
 * 第二页 · 方案配置与对比
 *
 * 入口：next.html?handoff=<令牌>（正式）或 next.html?demo=1（本地演示）
 * 数据：public/data/h3-parts.json（28 个零件类型 × 10 个型号 = 基础四款 + 两个厂家各 3 款）
 *
 * 结构：
 *   - 左栏：用户自配器。从系统推荐复制或从零开始，创建用户自配 1/2/3…
 *   - 中栏：对比矩阵。列 = 系统推荐 + 用户自配；行 = 模块 / 零件类型；
 *           格子 = 该方案选中的零件名，悬停显示核心参数。
 *   - 右栏：零件详情 + 模型占位。
 *
 * 只有所有用户自配方案都填满 28 个零件类型，"开始对比"才可用。
 */

(() => {
  const DEMO = new URLSearchParams(location.search).get("demo") === "1";
  const TOKEN = (new URLSearchParams(location.search).get("handoff") || "").trim();
  const STORAGE_PREFIX = "atlas.stage2";
  // 零件列约占表格宽度 1/4（140–240px），方案列不低于 160px；超出容器时横向滚动。
  const TYPE_COL_MIN = 140;
  const TYPE_COL_MAX = 240;
  const TYPE_COL_RATIO = 0.25;
  const SCHEME_COL_WIDTH = 160;

  const state = {
    payload: null,
    library: null,
    modules: [],
    partTypes: new Map(),
    variants: new Map(),
    system: new Map(),
    heroConstraints: [],
    schemes: [],
    schemeSeq: 0,
    activeSchemeId: null,
    expandedType: null,
    inspected: null,
    compareMode: false,
    tab: "compare",
    delivery: { start: "", end: "", basisId: "", hidden: [] },
    storageKey: "",
    handoffName: "",
    resetArmed: false,
    resetTimer: 0,
    recMode: "greedy",
    rec: null,
    score: {
      preset: "balanced",
      weights: { cost: 20, weight: 20, perf: 20, risk: 25, fit: 15 },
    },
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "style") node.style.cssText = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else node.setAttribute(key, value === true ? "" : String(value));
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  function fmtMoney(value) {
    return `¥ ${Math.round(Number(value) || 0).toLocaleString("zh-CN")}`;
  }

  function fmtWeight(value) {
    const number = Math.round((Number(value) || 0) * 10) / 10;
    return `${number.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} g`;
  }

  function fmtLead(value) {
    return `${Number(value) || 0} 天`;
  }

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.hidden = false;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      node.classList.remove("show");
      setTimeout(() => {
        node.hidden = true;
      }, 200);
    }, 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    }
  }

  class BootError extends Error {
    constructor(title, message, retry = true) {
      super(message);
      this.title = title;
      this.retry = retry;
    }
  }

  async function fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function boot() {
    try {
      const [tableData, library, handoff] = await Promise.all([
        fetchJson("/api/table1").catch(() => null),
        fetchJson("./data/h3-parts.json"),
        loadPayload(),
      ]);
      init(library, handoff, tableData);
      renderAll();
      switchTab(state.tab);
    } catch (error) {
      const known = error instanceof BootError;
      showBootError(
        known ? error.title : "第二页加载失败",
        known ? error.message : error?.message || "未知错误",
        known ? error.retry : true,
      );
    }
  }

  async function loadPayload() {
    if (DEMO) {
      const payload = await fetchJson("./data/demo-requirement.json");
      return { payload, name: payload.projectName || "" };
    }
    if (!TOKEN) {
      throw new BootError(
        "没有交接令牌",
        "本页需要从第一页点击「进入下一阶段」进入；直接打开时拿不到需求数据。",
        false,
      );
    }
    const response = await fetch(`/api/handoff/${encodeURIComponent(TOKEN)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        throw new BootError(
          "登录已失效",
          "交接内容只对生成它的身份码开放。请回到第一页重新登录，再点一次「进入下一阶段」。",
          false,
        );
      }
      if (response.status === 404 || response.status === 410) {
        throw new BootError(
          "交接已过期或不存在",
          data.message || "请回到第一页重新进入下一阶段。",
          false,
        );
      }
      throw new BootError(
        "交接读取失败",
        `${data.message || "服务返回错误"}（HTTP ${response.status}）`,
      );
    }
    return { payload: data.payload, name: data.name || "" };
  }

  function init(library, handoff, tableData) {
    const payload = handoff.payload;
    state.library = library;
    state.payload = payload;
    state.handoffName = handoff.name || "";
    globalThis.__STAGE2_PAYLOAD__ = payload;

    const libraryParts = new Map();
    for (const module of library.modules || []) {
      for (const part of module.parts || []) libraryParts.set(part.code, part);
    }

    const tableType =
      (tableData?.table1?.productTypes || []).find((type) => type.id === library.productType) ||
      (tableData?.table1?.productTypes || [])[0];
    const tableModules = tableType?.modules?.length ? tableType.modules : library.modules || [];

    state.modules = tableModules.map((module, index) => ({
      ...module,
      index: module.index || index + 1,
      parts: (module.parts || [])
        .map((part) => {
          const source = libraryParts.get(part.code) || part;
          return {
            ...part,
            variants: source.variants || [],
            baselineVariantId: source.baselineVariantId,
          };
        })
        .filter((part) => (part.variants || []).length > 0),
    }));

    for (const module of state.modules) {
      for (const part of module.parts) {
        const type = {
          ...part,
          moduleCode: module.code,
          moduleName: module.name,
          moduleIndex: module.index,
        };
        state.partTypes.set(type.code, type);
        for (const variant of type.variants || []) {
          state.variants.set(variant.id, {
            ...variant,
            typeCode: type.code,
            typeName: type.name,
            qty: type.qty,
            moduleCode: module.code,
            moduleName: module.name,
          });
        }
      }
    }

    state.recMode = recModeFromUrl();
    // 起点是全标准件；restoreState 恢复权重后再跑一次多起点爬山，所以这里先放基线。
    state.system = standardSelection();
    state.storageKey = `${STORAGE_PREFIX}.${DEMO ? "demo" : TOKEN.slice(0, 16)}`;
    state.inspected = defaultInspection();
    restoreState();
    // 系统推荐按恢复后的权重重算：权重不同 → 推荐的最优组合不同。
    ensureRecommendation(true);
  }

  function defaultInspection() {
    const first = state.partTypes.values().next().value;
    if (!first) return null;
    return { variantId: first.baselineVariantId, schemeId: "system" };
  }

  function restoreState() {
    try {
      const raw = sessionStorage.getItem(state.storageKey);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object") return;

      if (Array.isArray(saved.schemes)) {
        state.schemes = saved.schemes
          .filter(
            (scheme) =>
              scheme &&
              typeof scheme.id === "string" &&
              typeof scheme.name === "string" &&
              scheme.id !== "system",
          )
          .map((scheme) => ({
            id: scheme.id,
            name: scheme.name,
            mode: scheme.mode === "system" ? "system" : "zero",
            parts: sanitizeParts(scheme.parts),
          }));
      }

      if (saved.score && typeof saved.score === "object" && saved.score.weights) {
        // 旧版会话里是 成本/重量/交期/风险/约束 五项权重：维度已经变了（交期并入风险、
        // 新增性能），旧权重直接作废，回到预设，免得拼出一套对不上号的权重。
        const legacy =
          "lead" in saved.score.weights || !("perf" in saved.score.weights);
        if (!legacy) {
          const weights = {};
          for (const dim of SCORE_DIMS) {
            const value = Number(saved.score.weights[dim.id]);
            weights[dim.id] = Number.isFinite(value) ? Math.min(60, Math.max(0, value)) : 0;
          }
          state.score = {
            preset: SCORE_PRESETS[saved.score.preset] ? saved.score.preset : "custom",
            weights,
          };
        }
      }

      // 交付排期：日期窗与排期基准是可复现的输入，跟着会话走。
      if (saved.delivery && typeof saved.delivery === "object") {
        const start = /^\d{4}-\d{2}-\d{2}$/.test(saved.delivery.start || "")
          ? saved.delivery.start
          : "";
        const end = /^\d{4}-\d{2}-\d{2}$/.test(saved.delivery.end || "") ? saved.delivery.end : "";
        state.delivery = {
          start,
          end: end && start && end >= start ? end : "",
          basisId: typeof saved.delivery.basisId === "string" ? saved.delivery.basisId : "",
          hidden: Array.isArray(saved.delivery.hidden)
            ? saved.delivery.hidden.filter((lane) => typeof lane === "string")
            : [],
        };
      }

      state.schemeSeq = Math.max(Number(saved.schemeSeq) || 0, state.schemes.length);
      renumberSchemes();
      state.activeSchemeId = state.schemes.some((scheme) => scheme.id === saved.activeSchemeId)
        ? saved.activeSchemeId
        : state.schemes[0]?.id ?? null;
      state.compareMode = Boolean(saved.compareMode) && canCompare();
      if (saved.expandedType && state.partTypes.has(saved.expandedType)) {
        state.expandedType = saved.expandedType;
      }
      if (
        state.inspected?.schemeId !== "system" &&
        !state.schemes.some((scheme) => scheme.id === state.inspected?.schemeId)
      ) {
        state.inspected = defaultInspection();
      }
    } catch {
      /* 会话存储不可用时忽略 */
    }
  }

  function sanitizeParts(raw) {
    const parts = {};
    if (!raw || typeof raw !== "object") return parts;
    for (const [typeCode, variantId] of Object.entries(raw)) {
      if (!state.partTypes.has(typeCode)) continue;
      const variant = state.variants.get(variantId);
      if (!variant || variant.typeCode !== typeCode) continue;
      parts[typeCode] = variantId;
    }
    return parts;
  }

  function saveState() {
    try {
      sessionStorage.setItem(
        state.storageKey,
        JSON.stringify({
          schemes: state.schemes,
          schemeSeq: state.schemeSeq,
          activeSchemeId: state.activeSchemeId,
          compareMode: state.compareMode,
          expandedType: state.expandedType,
          score: state.score,
          delivery: state.delivery,
        }),
      );
    } catch {
      /* 忽略 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 状态查询                                                            */
  /* ------------------------------------------------------------------ */

  function activeScheme() {
    return state.schemes.find((scheme) => scheme.id === state.activeSchemeId) ?? null;
  }

  function schemeById(id) {
    return state.schemes.find((scheme) => scheme.id === id) ?? null;
  }

  // 列名永远按当前顺序从 1 开始顺连；删除中间方案后不留空号。
  function renumberSchemes() {
    state.schemes.forEach((scheme, index) => {
      scheme.name = `用户自配${index + 1}`;
    });
  }

  function totalPartTypes() {
    return state.partTypes.size;
  }

  function countSelected(parts) {
    let count = 0;
    for (const code of state.partTypes.keys()) {
      if (variantIdOf(parts, code)) count += 1;
    }
    return count;
  }

  function variantIdOf(parts, typeCode) {
    if (!parts) return null;
    if (parts instanceof Map) return parts.get(typeCode) || null;
    return parts[typeCode] || null;
  }

  function isComplete(scheme) {
    return countSelected(scheme?.parts) === totalPartTypes();
  }

  function canCompare() {
    return state.schemes.length > 0 && state.schemes.every(isComplete);
  }

  function totalsFor(parts) {
    let price = 0;
    let weight = 0;
    let lead = 0;
    let count = 0;
    const entries = parts instanceof Map ? parts.entries() : Object.entries(parts || {});
    for (const [typeCode, variantId] of entries) {
      const variant = state.variants.get(variantId);
      if (!variant || variant.typeCode !== typeCode) continue;
      count += 1;
      price += variant.price * variant.qty;
      weight += variant.weight * variant.qty;
      lead = Math.max(lead, variant.leadTime);
    }
    return { price, weight, lead, count };
  }

  /**
   * 单型号的评分指标（已乘用量），缓存起来给增量试算用。
   * 多起点爬山每次要试算上万次，逐次重建整机数组太慢，所以拆成"单件指标 + 差值"。
   */
  let variantMetrics = null;

  function variantMetricOf(variantId) {
    if (!variantMetrics) variantMetrics = new Map();
    let metric = variantMetrics.get(variantId);
    if (metric) return metric;
    const variant = state.variants.get(variantId);
    if (!variant) {
      metric = { price: 0, weight: 0, lead: 0, perf: 0, risk: 0 };
    } else {
      const qty = Number(variant.qty) || 1;
      metric = {
        price: (Number(variant.price) || 0) * qty,
        weight: (Number(variant.weight) || 0) * qty,
        lead: Number(variant.leadTime) || 0,
        perf: (Number(variant.performance) || 0) * qty,
        risk: variantRiskOf(variant),
      };
    }
    variantMetrics.set(variantId, metric);
    return metric;
  }

  /** 一个选型的整机指标：价格 / 重量 / 最长交期 / 性能合计 / 风险合计与均值。 */
  function metricsOf(parts) {
    const entries = parts instanceof Map ? parts.entries() : Object.entries(parts || {});
    let price = 0;
    let weight = 0;
    let lead = 0;
    let perf = 0;
    let riskSum = 0;
    let count = 0;
    for (const [, variantId] of entries) {
      if (!state.variants.has(variantId)) continue;
      const metric = variantMetricOf(variantId);
      price += metric.price;
      weight += metric.weight;
      perf += metric.perf;
      riskSum += metric.risk;
      lead = Math.max(lead, metric.lead);
      count += 1;
    }
    return { price, weight, lead, perf, riskSum, count, risk: count ? riskSum / count : 0 };
  }

  /** 列的指标：算过一次就挂在列对象上，渲染和评分复用。 */
  function metricsFor(column) {
    if (column.metrics) return column.metrics;
    column.metrics = metricsOf(column.parts);
    return column.metrics;
  }

  function diffForType(typeCode) {
    const ids = new Set();
    const systemVariant = state.system.get(typeCode);
    if (systemVariant) ids.add(systemVariant);
    for (const scheme of state.schemes) {
      const variant = scheme.parts[typeCode];
      if (variant) ids.add(variant);
    }
    return ids.size > 1;
  }

  function diffCount() {
    let count = 0;
    for (const code of state.partTypes.keys()) {
      if (diffForType(code)) count += 1;
    }
    return count;
  }

  /* ------------------------------------------------------------------ */
  /* 约束校验                                                            */
  /* ------------------------------------------------------------------ */

  function normalizeOperator(raw) {
    const value = String(raw ?? "").trim();
    const map = {
      "≤": "<=",
      "≦": "<=",
      "≥": ">=",
      "≧": ">=",
      "＜": "<",
      "＞": ">",
      "＝": "=",
      "==": "=",
      "=<": "<=",
      "=>": ">=",
      "不超过": "<=",
      "最多": "<=",
      "小于等于": "<=",
      "不少于": ">=",
      "至少": ">=",
      "大于等于": ">=",
      "低于": "<",
      "小于": "<",
      "高于": ">",
      "大于": ">",
      "等于": "=",
    };
    if (map[value]) return map[value];
    return ["<=", ">=", "<", ">", "="].includes(value) ? value : null;
  }

  function parseNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function compareNumber(actual, operator, target) {
    switch (operator) {
      case "<=":
        return actual <= target;
      case ">=":
        return actual >= target;
      case "<":
        return actual < target;
      case ">":
        return actual > target;
      case "=":
        return actual === target;
      default:
        return false;
    }
  }

  function constraintTarget(constraint) {
    const dimension = String(constraint.dimension || "").toLowerCase();
    const raw = parseNumber(constraint.value);
    if (raw === null) return null;
    const unit = String(constraint.unit || "").toLowerCase();

    if (dimension === "weight") {
      const factor =
        unit.includes("kg") || unit.includes("千克") || unit.includes("公斤")
          ? 1000
          : unit.includes("mg")
            ? 0.001
            : 1;
      return { value: raw * factor, text: `${raw} ${constraint.unit || "g"}` };
    }
    if (dimension === "budget" || dimension === "cost") {
      const factor = unit.includes("万") ? 10000 : unit.includes("千") ? 1000 : 1;
      return { value: raw * factor, text: `${raw} ${constraint.unit || "CNY"}` };
    }
    if (["lead_time", "leadtime", "delivery"].includes(dimension)) {
      const factor =
        unit.includes("周") || unit.includes("week")
          ? 7
          : unit.includes("月") || unit.includes("month")
            ? 30
            : 1;
      return { value: raw * factor, text: `${raw} ${constraint.unit || "day"}` };
    }
    return null;
  }

  function operatorSymbol(raw) {
    const operator = normalizeOperator(raw);
    const symbols = { "<=": "≤", ">=": "≥", "<": "<", ">": ">", "=": "=" };
    return symbols[operator] || String(raw ?? "").trim();
  }

  function unitLabel(raw) {
    const unit = String(raw || "").trim();
    if (!unit) return "";
    if (unit.toLowerCase() === "cny" || unit === "元") return "元";
    if (unit.toLowerCase() === "day" || unit === "天") return "天";
    return unit;
  }

  function displayOf(constraint) {
    const name = constraint.name ? String(constraint.name) : constraintLabel(constraint);
    const operator = operatorSymbol(constraint.operator);
    const value = constraint.value ?? "";
    if (name && operator && value !== "") {
      const unit = unitLabel(constraint.unit);
      return `${name} ${operator} ${value}${unit ? ` ${unit}` : ""}`;
    }
    if (constraint.display) return String(constraint.display);
    return `${name} ${constraint.operator || ""} ${value}${constraint.unit || ""}`;
  }

  function constraintLabel(constraint) {
    const dimension = String(constraint.dimension || "").toLowerCase();
    const labels = {
      weight: "整机重量",
      budget: "BOM 成本",
      cost: "BOM 成本",
      lead_time: "交付周期",
      leadtime: "交付周期",
      delivery: "交付周期",
      ingress: "防护等级",
    };
    return constraint.name || labels[dimension] || "硬约束";
  }

  function evaluateConstraint(constraint, totals) {
    const dimension = String(constraint.dimension || "").toLowerCase();
    const operator = normalizeOperator(constraint.operator);
    const target = constraintTarget(constraint);

    if (dimension === "none") return { supported: false, skipped: true };
    if (!["weight", "budget", "cost", "lead_time", "leadtime", "delivery"].includes(dimension)) {
      return {
        supported: false,
        display: displayOf(constraint),
        reason: "该维度暂不支持自动校验，需人工确认",
      };
    }
    if (!operator || !target) {
      return { supported: false, display: displayOf(constraint), reason: "无法解析数值或运算符" };
    }

    let actual;
    let actualText;
    if (dimension === "weight") {
      actual = totals.weight;
      actualText = fmtWeight(actual);
    } else if (dimension === "budget" || dimension === "cost") {
      actual = totals.price;
      actualText = fmtMoney(actual);
    } else if (["lead_time", "leadtime", "delivery"].includes(dimension)) {
      actual = totals.lead;
      actualText = fmtLead(actual);
    } else {
      return { supported: false, display: displayOf(constraint), reason: "维度暂不支持自动校验" };
    }

    return {
      supported: true,
      ok: compareNumber(actual, operator, target.value),
      display: displayOf(constraint),
      actualText,
      targetText: target.text,
    };
  }

  function constraintIsSoft(constraint) {
    return String(constraint?.priority || "").trim().toLowerCase() === "should";
  }

  /**
   * 约束预编译：字符串解析、运算符归一、显示文案这些每试算一次都要重做的事，
   * 只在第一页的约束数组变化时算一次。多起点爬山要跑上万次试算，这一步省得最多。
   */
  let constraintPlan = null;

  function constraintPlanOf() {
    const constraints = state.payload?.result?.constraints || [];
    if (constraintPlan && constraintPlan.source === constraints) return constraintPlan.items;
    const items = [];
    for (const constraint of constraints) {
      const dimension = String(constraint.dimension || "").toLowerCase();
      if (dimension === "none") continue;
      const operator = normalizeOperator(constraint.operator);
      const target = constraintTarget(constraint);
      const supported =
        ["weight", "budget", "cost", "lead_time", "leadtime", "delivery"].includes(dimension) &&
        Boolean(operator) &&
        Boolean(target);
      items.push({
        soft: constraintIsSoft(constraint),
        supported,
        kind:
          dimension === "weight" ? "weight" : dimension === "budget" || dimension === "cost" ? "price" : "lead",
        operator,
        target: target?.value,
        targetText: target?.text,
        display: displayOf(constraint),
      });
    }
    constraintPlan = { source: constraints, items };
    return items;
  }

  function evaluateConstraints(totals) {
    const items = constraintPlanOf();
    const violations = [];
    const unsupported = [];
    let checked = 0;
    let total = 0;

    for (const item of items) {
      total += 1;
      if (!item.supported) {
        unsupported.push(item.display);
        continue;
      }
      checked += 1;
      let actual;
      if (item.kind === "weight") actual = totals.weight;
      else if (item.kind === "price") actual = totals.price;
      else actual = totals.lead;
      if (compareNumber(actual, item.operator, item.target)) continue;
      violations.push({
        display: item.display,
        actualText:
          item.kind === "weight" ? fmtWeight(actual) : item.kind === "price" ? fmtMoney(actual) : fmtLead(actual),
        targetText: item.targetText,
        // 第一页把约束分成 must（硬）/ should（软），软约束不满足只扣分封顶，不算硬伤
        soft: item.soft,
      });
    }

    return { violations, unsupported, checked, total };
  }

  /* ------------------------------------------------------------------ */
  /* 方案评分：可调权重 + 绝对标尺                                        */
  /*                                                                     */
  /* 口径与《ATLAS-三轴云台方案对比与BOM》一致：                          */
  /*   1. 每个维度的 0–100 分来自**零件库自身的可行区间**（绝对标尺），   */
  /*      与"这一轮有哪几个对手、它们表现多差"无关——                   */
  /*      对手不合格不会把别人抬成满分；                                  */
  /*   2. 成本 / 重量 / 风险 越低越好，性能 / 约束满足率越高越好；        */
  /*   3. 交期已并入风险：零件风险等级占 60%、零件交期档位占 40%，         */
  /*      不再单独设"交期"权重；                                          */
  /*   4. 性能 = 每个型号 3 个核心参数按绝对区间归一化后的加权分（0–100）， */
  /*      按用量累加；                                                    */
  /*   5. 综合得分 = √(Σ 维度得分 × 归一化权重) × 10，再按约束封顶。     */
  /* ------------------------------------------------------------------ */

  const SCORE_DIMS = [
    {
      id: "cost",
      label: "成本",
      hint: "BOM 总价越低得分越高",
      color: "#f2b880",
      better: "low",
      value: (column) => column.total.price,
    },
    {
      id: "weight",
      label: "重量",
      hint: "整机重量越轻得分越高",
      color: "#6ee7d0",
      better: "low",
      value: (column) => column.total.weight,
    },
    {
      id: "perf",
      label: "性能",
      hint: "核心参数综合表现，越高越好",
      color: "#8ab4f8",
      better: "high",
      value: (column) => metricsFor(column).perf,
    },
    {
      id: "risk",
      label: "风险",
      hint: "零件风险 60% + 交期 40%，越低越好",
      color: "#c79bf0",
      better: "low",
      value: (column) => metricsFor(column).risk,
    },
    {
      id: "fit",
      label: "约束",
      hint: "硬性约束满足率",
      color: "#9ad46f",
      better: "high",
      value: (column) => fitRatio(column),
    },
  ];

  const SCORE_PRESETS = {
    balanced: { label: "均衡", weights: { cost: 20, weight: 20, perf: 20, risk: 25, fit: 15 } },
    budget: { label: "成本优先", weights: { cost: 40, weight: 10, perf: 10, risk: 20, fit: 20 } },
    light: { label: "轻量优先", weights: { cost: 15, weight: 40, perf: 10, risk: 20, fit: 15 } },
    safe: { label: "安全优先", weights: { cost: 15, weight: 10, perf: 5, risk: 55, fit: 15 } },
    perf: { label: "性能优先", weights: { cost: 10, weight: 10, perf: 55, risk: 10, fit: 15 } },
  };

  let scoreCtx = { columns: [], signature: "" };
  let scoreRange = null;

  /** 单个型号的风险分：高 = 2，中 = 1，低 = 0。 */
  function riskOf(variant) {
    if (!variant) return 0;
    if (variant.risk === "高") return 2;
    if (variant.risk === "中") return 1;
    return 0;
  }

  /** 全库交期三分位：用来把交期折成 0 / 1 / 2 三档，和风险等级同一量纲。 */
  let leadBands = null;

  function leadBandsOf() {
    if (leadBands) return leadBands;
    const leads = [];
    for (const type of state.partTypes.values()) {
      for (const variant of type.variants || []) {
        const lead = Number(variant.leadTime);
        if (Number.isFinite(lead)) leads.push(lead);
      }
    }
    leads.sort((a, b) => a - b);
    const at = (ratio) =>
      leads.length ? leads[Math.min(leads.length - 1, Math.floor((leads.length - 1) * ratio))] : 0;
    leadBands = { fast: at(1 / 3), slow: at(2 / 3) };
    return leadBands;
  }

  /** 单件交期档位：快 = 0，中 = 1，慢 = 2（越低越稳）。 */
  function leadRiskOf(variant) {
    const lead = Number(variant?.leadTime);
    if (!Number.isFinite(lead)) return 0;
    const { fast, slow } = leadBandsOf();
    if (lead <= fast) return 0;
    if (lead <= slow) return 1;
    return 2;
  }

  // 风险维度里两块的占比：零件本身的风险等级 60%，采购交期 40%。
  const RISK_PART_WEIGHT = 0.6;
  const RISK_LEAD_WEIGHT = 0.4;

  /** 单个型号的风险分（含交期）：0 = 最稳，100 = 最差。 */
  function variantRiskOf(variant) {
    return (
      (riskOf(variant) / 2) * RISK_PART_WEIGHT * 100 +
      (leadRiskOf(variant) / 2) * RISK_LEAD_WEIGHT * 100
    );
  }

  /**
   * 风险分（含交期）：把每个零件的「风险等级 0–2」和「交期档位 0–2」先各自
   * 归一到 0–100，再按 60/40 合成，最后对全机零件取平均。0 = 最稳，100 = 最差。
   */
  function riskIndex(column) {
    return metricsFor(column).risk;
  }

  /** 单机平均性能分（0–100），给汇总卡片和面板展示用。 */
  function performanceOf(parts) {
    const entries = parts instanceof Map ? parts.entries() : Object.entries(parts || {});
    let sum = 0;
    let count = 0;
    for (const [, variantId] of entries) {
      const variant = state.variants.get(variantId);
      if (!variant) continue;
      sum += Number(variant.performance) || 0;
      count += 1;
    }
    return count ? sum / count : 0;
  }

  /** 约束满足率：没有可校验的约束时按满足处理（0–1，绝对口径）。 */
  function fitRatio(column) {
    const check = column.check || {};
    if (!check.checked) return 1;
    return Math.max(0, (check.checked - (check.violations?.length || 0)) / check.checked);
  }

  /**
   * 绝对标尺：把整个零件库逐类型取极值再按数量累加，得到"这台机器在库里
   * 能拼出的最省 / 最贵 / 最轻 / 最重 / 最短 / 最长交期 / 最低 / 最高风险"。
   * 标尺只跟零件库有关，换方案、删对手都不会变——这是"不给对手送满分"的关键。
   *
   * 再把理想最优解 / 最劣解各向外拉，使区间长度 = 原区间的 STRETCH 倍：
   * 贴到可行边界的方案拿到 100/STRETCH 分左右，而不是直接满分。
   */
  const SCORE_STRETCH = 1.5;

  function stretchRange(range) {
    const pad = (SCORE_STRETCH - 1) / 2;
    for (const key of Object.keys(range)) {
      const { min, max } = range[key];
      const extra = (max - min) * pad;
      range[key] = { min: min - extra, max: max + extra };
    }
    return range;
  }

  function computeScoreRange() {
    const range = {
      cost: { min: 0, max: 0 },
      weight: { min: 0, max: 0 },
      perf: { min: 0, max: 0 },
      // 风险是已经归一化到 0–100 的合成分，定义域本身就是标尺。
      risk: { min: 0, max: 100 },
      fit: { min: 0, max: 1 },
    };
    for (const type of state.partTypes.values()) {
      const variants = type.variants || [];
      if (variants.length === 0) continue;
      const qty = Number(type.qty) || 1;
      const prices = variants.map((variant) => (Number(variant.price) || 0) * qty);
      const weights = variants.map((variant) => (Number(variant.weight) || 0) * qty);
      const perfs = variants.map((variant) => (Number(variant.performance) || 0) * qty);
      range.cost.min += Math.min(...prices);
      range.cost.max += Math.max(...prices);
      range.weight.min += Math.min(...weights);
      range.weight.max += Math.max(...weights);
      range.perf.min += Math.min(...perfs);
      range.perf.max += Math.max(...perfs);
    }
    return stretchRange(range);
  }

  function absoluteRange() {
    if (!scoreRange) scoreRange = computeScoreRange();
    return scoreRange;
  }

  function dimScore(dim, column) {
    const { min, max } = absoluteRange()[dim.id];
    const value = Number(dim.value(column)) || 0;
    if (max - min < 1e-9) return 100;
    const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
    return (dim.better === "low" ? 1 - ratio : ratio) * 100;
  }

  function weightedScore(column, weights) {
    const sum = SCORE_DIMS.reduce((total, dim) => total + (Number(weights[dim.id]) || 0), 0);
    if (sum <= 0) return { total: 0, parts: {} };
    const parts = {};
    let total = 0;
    for (const dim of SCORE_DIMS) {
      const share = (dimScore(dim, column) * (Number(weights[dim.id]) || 0)) / sum;
      parts[dim.id] = share;
      total += share;
    }
    return { total, parts };
  }

  /**
   * 试算专用的加权分：与 weightedScore 同一个口径，但不建 parts 对象。
   * 多起点爬山一次要跑两三万次，少分配几个对象就是几十毫秒。
   */
  function rawScoreFor(column) {
    const weights = state.score.weights;
    const range = absoluteRange();
    let weightSum = 0;
    let total = 0;
    for (const dim of SCORE_DIMS) {
      const weight = Number(weights[dim.id]) || 0;
      weightSum += weight;
      if (weight <= 0) continue;
      const { min, max } = range[dim.id];
      const value = Number(dim.value(column)) || 0;
      const ratio =
        max - min < 1e-9 ? 1 : Math.min(1, Math.max(0, (value - min) / (max - min)));
      const score = (dim.better === "low" ? 1 - ratio : ratio) * 100;
      total += score * weight;
    }
    return weightSum > 0 ? total / weightSum : 0;
  }

  /**
   * 最终得分：
   *   1. 开根号放大 —— sqrt(raw) × 10，单调变换，相对排名不变，但分数整体更高；
   *   2. 约束封顶 —— 硬约束不满足 ≤ 20，软约束（第一页 priority=should）不满足 ≤ 60。
   */
  const SCORE_CAP = { hard: 20, soft: 60, none: 100 };

  function scoreCapFor(column) {
    const violations = column.check?.violations || [];
    if (violations.some((item) => !item.soft)) return { cap: SCORE_CAP.hard, kind: "hard" };
    if (violations.some((item) => item.soft)) return { cap: SCORE_CAP.soft, kind: "soft" };
    return { cap: SCORE_CAP.none, kind: "none" };
  }

  function finalScore(raw, column) {
    const shaped = Math.min(100, Math.sqrt(Math.max(0, Number(raw) || 0)) * 10);
    const { cap, kind } = scoreCapFor(column);
    const score = Math.min(shaped, cap);
    return { score, shaped, cap, capped: shaped > cap + 1e-9, capKind: kind };
  }

  /* ------------------------------------------------------------------ */
  /* 系统推荐：极速引擎（多起点爬山）                                      */
  /*                                                                     */
  /* 组合空间 = Π(每个零件类型的型号数)：28 类 × 10 型号 ≈ 1.0×10²⁸ 种，   */
  /* 穷举不可能，所以用「多起点 + 爬山」：                                 */
  /*   1. 起点不止一个：全标准件 / 全最低价 / 全最轻 / 全最高性能 /         */
  /*      全最低风险，各铺一套完整选型；                                    */
  /*   2. 每一路都从自己的起点出发，每轮把所有"只换一个零件"的动作全试算    */
  /*      一遍，取涨分最多的执行，直到没有单件替换还能涨分；                */
  /*   3. 各路跑到各自的局部最优，取其中最好的那一路作为系统推荐。          */
  /*                                                                     */
  /* 多起点的意义：爬山只能保证局部最优，"从全标准件出发"会卡在离起点最近  */
  /* 的那个坑里；换 4 个起点各爬一次，实测能跳出 3–15 分的坑（见自检       */
  /* __STAGE2_SOLVER_CHECK__），代价是试算次数 ×5。                        */
  /*                                                                     */
  /* 涨分口径（逐级比较）：                                                */
  /*   硬约束违规数↓ → 最终得分↑ → 封顶前原始分↑ → 软约束违规数↓ → 总价↓。 */
  /*   先比硬约束：硬约束一旦不满足，最终得分被封在 20，只看最终得分的话    */
  /*   所有违规方案都停在 20 分，是一条平地，爬山永远走不出违规区。         */
  /*   比原始分是为了"全都被封顶"的情况（约束根本满足不了时）：显示分不动， */
  /*   但原始分还能继续往上推，推荐才不会一开跑就停在起点。                 */
  /*                                                                     */
  /* 枚举（?rec=enum）留作精确对照，只在组合数 ≤ REC_ENUM_LIMIT 时启用；   */
  /* 当前零件库远超上限，页面上会直接写明"已回退极速引擎"，不假装跑过枚举。 */
  /* ------------------------------------------------------------------ */

  const REC_ENUM_LIMIT = 200000;

  function recModeFromUrl() {
    try {
      return new URLSearchParams(location.search).get("rec") === "enum" ? "enum" : "greedy";
    } catch {
      return "greedy";
    }
  }

  /** 标准件：优先 tierKey=std，其次表1 基线，最后退到第一个型号。 */
  function standardVariantOf(type) {
    const variants = type?.variants || [];
    if (variants.length === 0) return null;
    return (
      variants.find((variant) => variant.tierKey === "std") ||
      variants.find((variant) => variant.id === type.baselineVariantId) ||
      variants[0]
    );
  }

  /**
   * 候选池：当前零件库的全部型号，按类型分组。
   * 故意不在这里做"过滤"——推荐结果应该忠实反映零件库里有什么，
   * 库里混进了不可比的采集件属于数据问题，交给界面提示（见 marketPicks），
   * 而不是让推荐引擎悄悄假装没有这个件。
   */
  function candidatePool() {
    const pool = new Map();
    let total = 0;
    for (const [code, type] of state.partTypes) {
      const variants = type.variants || [];
      if (!variants.length) continue;
      total += variants.length;
      pool.set(code, variants);
    }
    return { pool, total };
  }

  /** 全标准件选型：系统推荐的起点，也是"没有优化"时的对照基线。 */
  function standardSelection(pool = candidatePool().pool) {
    const selection = new Map();
    for (const [code, type] of state.partTypes) {
      const variant = standardVariantOf({ ...type, variants: pool.get(code) || type.variants });
      if (variant) selection.set(code, variant.id);
    }
    return selection;
  }

  function comboSpace(pool = candidatePool().pool) {
    let total = 1;
    for (const variants of pool.values()) {
      if (!variants.length) continue;
      total *= variants.length;
    }
    return total;
  }

  function superscript(value) {
    return String(value)
      .split("")
      .map((char) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(char)] ?? char)
      .join("");
  }

  function formatCombos(value) {
    if (!Number.isFinite(value)) return "∞";
    if (value < 10000) return value.toLocaleString("zh-CN");
    const exponent = Math.floor(Math.log10(value));
    return `${(value / 10 ** exponent).toFixed(1)}×10${superscript(exponent)}`;
  }

  /** 试算一组整机指标：约束校验 → 加权原始分 → 开根与封顶。 */
  function evaluateMetrics(metrics, selection) {
    const total = {
      price: metrics.price,
      weight: metrics.weight,
      lead: metrics.lead,
      count: metrics.count,
    };
    const check = evaluateConstraints(total);
    const column = { parts: selection || null, total, check, complete: true, metrics };
    const raw = rawScoreFor(column);
    const final = finalScore(raw, column);
    const hard = check.violations.filter((item) => !item.soft).length;
    return {
      selection,
      metrics,
      total,
      check,
      raw,
      shaped: final.shaped,
      score: final.score,
      capKind: final.capKind,
      hard,
      soft: check.violations.length - hard,
    };
  }

  /** 试算一个完整选型。 */
  function selectionEval(selection) {
    return evaluateMetrics(metricsOf(selection), selection);
  }

  /** a 是否严格优于 b（逐级比较，同分时用更便宜的方案定序，保证可终止）。 */
  function betterEval(a, b) {
    if (!a) return false;
    if (!b) return true;
    if (a.hard !== b.hard) return a.hard < b.hard;
    if (Math.abs(a.score - b.score) > 1e-9) return a.score > b.score;
    // 得分相同通常是"都被封顶"：这时用封顶前的原始分继续拉开差距。
    if (Math.abs(a.shaped - b.shaped) > 1e-9) return a.shaped > b.shaped;
    if (a.soft !== b.soft) return a.soft < b.soft;
    if (Math.abs(a.total.price - b.total.price) > 1e-6) return a.total.price < b.total.price;
    return false;
  }

  /**
   * 一步置换值不值得走。满足其一即可：
   *   - 少一条硬约束违规（硬约束一破，得分就被封在 20，先修它）；
   *   - 最终得分涨 ≥ REC_MIN_GAIN；
   *   - 得分已经被封顶（谁都到不了更高的显示分），那就比封顶前的原始分。
   * REC_MIN_GAIN = 0.05 是面板显示精度：再小的边际置换（实测最小 0.003 分）
   * 全都采纳的结果是"28 个件换了 27 个"却只多 0.03 分，推荐反而不像推荐。
   * "同分但更便宜"同样不算——同分候选之间仍然用更便宜的定序（betterEval 最后一条）。
   */
  const REC_MIN_GAIN = 0.05;

  function stepQualifies(candidate, current) {
    if (candidate.hard > current.hard) return false;
    if (candidate.hard < current.hard) return true;
    if (candidate.score >= current.score + REC_MIN_GAIN - 1e-9) return true;
    const capped = Math.abs(candidate.score - current.score) <= 1e-9;
    return capped && candidate.shaped >= current.shaped + REC_MIN_GAIN - 1e-9;
  }

  function stepReason(candidate, current) {
    if (candidate.hard < current.hard) return "hard";
    if (candidate.score >= current.score + REC_MIN_GAIN - 1e-9) {
      return candidate.soft < current.soft ? "soft" : "score";
    }
    return "shaped";
  }

  /**
   * 爬山：从给定的起点选型出发，每轮扫遍"换一件"的所有候选，执行涨分最大的那一步，
   * 直到没有任何单件替换还能涨分（1-邻域局部最优）。
   * 返回每一步的置换明细，便于在界面上解释"推荐为什么长这样"。
   */
  function hillClimb(pool, startSelection) {
    const types = [...pool.keys()];
    const slotOf = new Map(types.map((code, index) => [code, index]));
    // 最长交期是 max，不能增量；用"按类型存交期 + 每次扫 28 个数取 max"代替重建整机。
    const leadByType = types.map(
      (code) => Number(state.variants.get(startSelection.get(code))?.leadTime) || 0,
    );
    const selection = new Map(startSelection);
    const baseline = selectionEval(selection);
    let current = baseline;
    const steps = [];
    let evals = 1;
    let rounds = 0;

    while (rounds < 120) {
      rounds += 1;
      let best = null;
      for (const [code, variants] of pool) {
        const slot = slotOf.get(code);
        const chosen = selection.get(code);
        const oldMetric = variantMetricOf(chosen);
        const previousLead = leadByType[slot];
        for (const variant of variants) {
          if (variant.id === chosen) continue;
          const next = variantMetricOf(variant.id);
          leadByType[slot] = next.lead;
          let lead = 0;
          for (let index = 0; index < leadByType.length; index += 1) {
            if (leadByType[index] > lead) lead = leadByType[index];
          }
          const riskSum = current.metrics.riskSum - oldMetric.risk + next.risk;
          const metrics = {
            price: current.metrics.price - oldMetric.price + next.price,
            weight: current.metrics.weight - oldMetric.weight + next.weight,
            perf: current.metrics.perf - oldMetric.perf + next.perf,
            riskSum,
            count: current.metrics.count,
            lead,
            risk: current.metrics.count ? riskSum / current.metrics.count : 0,
          };
          const evaluated = evaluateMetrics(metrics);
          evals += 1;
          if (!stepQualifies(evaluated, current)) continue;
          if (!best || betterEval(evaluated, best.evaluated)) {
            best = { code, slot, from: chosen, variant, evaluated, reason: stepReason(evaluated, current) };
          }
        }
        leadByType[slot] = previousLead;
      }
      if (!best) break;
      const gain = best.evaluated.score - current.score;
      const shapedGain = best.evaluated.shaped - current.shaped;
      const variantInfo = state.variants.get(best.variant.id) || best.variant;
      selection.set(best.code, best.variant.id);
      leadByType[best.slot] = variantMetricOf(best.variant.id).lead;
      steps.push({
        typeCode: best.code,
        typeName: variantInfo.typeName || state.partTypes.get(best.code)?.name || best.code,
        fromId: best.from,
        fromName: state.variants.get(best.from)?.name || "—",
        toId: best.variant.id,
        toName: variantInfo.name,
        gain,
        shapedGain,
        reason: best.reason,
        score: best.evaluated.score,
      });
      current = best.evaluated;
    }

    return { selection, eval: current, baseline, steps, evals, rounds, method: "greedy" };
  }

  /** 单起点版本（自检脚本 / 枚举对照用）：从全标准件开始爬。 */
  function greedySelection(pool) {
    return hillClimb(pool, standardSelection(pool));
  }

  /* ---------------- 多起点：五套铺法，各爬一次，取最好的 ---------------- */

  /** better(a, b) 为真表示 a 比 b 更适合当起点。 */
  const pickBy = (variants, better) =>
    variants.reduce((best, variant) => (!best || better(variant, best) ? variant : best), null);

  /** 起点排序用的"稳妥分"：风险等级为主，交期档位次之，同档再比价格。 */
  const safeScoreOf = (variant) =>
    riskOf(variant) * 4 + leadRiskOf(variant) * 2 + (Number(variant.price) || 0) / 1000;

  /**
   * 五个起点。每个起点只负责"整套先摆成什么样子"，之后交给 hillClimb 修。
   * 用不同起点是为了让爬山从不同的坑里出发，降低卡在局部最优的概率。
   */
  const REC_STARTS = [
    {
      id: "std",
      label: "全标准件",
      pick: (variants) => standardVariantOf({ variants }),
    },
    {
      id: "cheap",
      label: "全最低价",
      pick: (variants) => pickBy(variants, (a, b) => a.price < b.price),
    },
    {
      id: "light",
      label: "全最轻",
      pick: (variants) => pickBy(variants, (a, b) => a.weight < b.weight),
    },
    {
      id: "perf",
      label: "全最高性能",
      pick: (variants) =>
        pickBy(variants, (a, b) => (a.performance || 0) > (b.performance || 0)),
    },
    {
      id: "safe",
      label: "全最低风险",
      pick: (variants) => pickBy(variants, (a, b) => safeScoreOf(a) < safeScoreOf(b)),
    },
  ];

  function startSelection(pool, pick) {
    const selection = new Map();
    for (const [code, variants] of pool) {
      const variant = variants.length ? pick(variants) : null;
      if (variant) selection.set(code, variant.id);
    }
    return selection;
  }

  /**
   * 极速引擎：五路爬山 → 取最优。
   * 起点相同的（例如某类全部最便宜恰好就是标准件）只爬一次，避免重复试算。
   */
  function multiStartSelection(pool) {
    const standard = standardSelection(pool);
    const baseline = selectionEval(standard);
    const seen = new Set();
    const starts = [];
    let best = null;
    let evals = 0;
    let rounds = 0;

    for (const start of REC_STARTS) {
      const seed = startSelection(pool, start.pick);
      const key = [...seed.values()].join("|");
      if (seen.has(key)) {
        starts.push({ id: start.id, label: start.label, score: null, skipped: true });
        continue;
      }
      seen.add(key);
      const climbed = hillClimb(pool, seed);
      evals += climbed.evals;
      rounds = Math.max(rounds, climbed.rounds);
      starts.push({
        id: start.id,
        label: start.label,
        score: climbed.eval.score,
        from: selectionEval(seed).score,
        steps: climbed.steps.length,
        evals: climbed.evals,
        rounds: climbed.rounds,
        skipped: false,
      });
      if (!best || betterEval(climbed.eval, best.eval)) {
        best = { ...climbed, startLabel: start.label, startId: start.id };
      }
    }

    return { ...best, baseline, starts, evals, rounds, method: "greedy" };
  }

  /** 枚举：深度优先穷举所有组合，取同一口径下的最好解（仅小库可用）。 */
  function enumSelection(pool) {
    const codes = [...pool.keys()];
    const selection = new Map();
    const baseline = selectionEval(standardSelection(pool));
    let best = null;
    let evals = 0;

    const walk = (index) => {
      if (index === codes.length) {
        const evaluated = selectionEval(selection);
        evals += 1;
        if (betterEval(evaluated, best?.eval)) {
          best = { selection: new Map(selection), eval: evaluated };
        }
        return;
      }
      for (const variant of pool.get(codes[index]) || []) {
        selection.set(codes[index], variant.id);
        walk(index + 1);
      }
    };
    walk(0);

    return {
      selection: best?.selection || standardSelection(pool),
      eval: best?.eval || baseline,
      baseline,
      steps: [],
      evals,
      rounds: 0,
      method: "enum",
    };
  }

  function recommendationSignature() {
    const weights = SCORE_DIMS.map((dim) => Number(state.score.weights[dim.id]) || 0).join(",");
    return `${state.recMode}|${weights}`;
  }

  function recMethodLabel(method = state.rec?.method) {
    if (method === "enum") return "精确枚举";
    if (method === "none") return "未优化";
    return "极速引擎";
  }

  function optimizeRecommendation(signature = recommendationSignature()) {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    const { pool, total: poolSize } = candidatePool();
    const combos = comboSpace(pool);
    const weightSum = SCORE_DIMS.reduce(
      (sum, dim) => sum + (Number(state.score.weights[dim.id]) || 0),
      0,
    );
    const base = {
      method: "none",
      requested: state.recMode,
      combos,
      poolSize,
      evals: 0,
      rounds: 0,
      steps: [],
      marketPicks: [],
      note: "",
      signature,
      ms: 0,
    };

    // 权重全为 0 时综合得分恒为 0，优化无从谈起：保持全标准件并说明原因。
    if (weightSum <= 0) {
      const selection = standardSelection(pool);
      const evaluated = selectionEval(selection);
      state.system = selection;
      state.rec = {
        ...base,
        baseline: evaluated,
        current: evaluated,
        note: "权重全为 0，综合得分不成立，系统推荐保持全标准件",
        ms: Math.round(((globalThis.performance?.now?.() ?? Date.now()) - startedAt) * 10) / 10,
      };
      return state.rec;
    }

    let method = state.recMode;
    let note = "";
    if (method === "enum" && combos > REC_ENUM_LIMIT) {
      method = "greedy";
      note = `组合空间 ${formatCombos(combos)} 超出枚举上限 ${REC_ENUM_LIMIT.toLocaleString("zh-CN")}，已回退极速引擎`;
    }

    const result = method === "enum" ? enumSelection(pool) : multiStartSelection(pool);
    const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;

    state.system = result.selection;
    state.rec = {
      ...base,
      method: result.method,
      evals: result.evals,
      rounds: result.rounds,
      steps: result.steps,
      starts: result.starts || [],
      bestStart: result.startLabel || "",
      note,
      baseline: result.baseline,
      current: result.eval,
      // 库里混进了 1688 原始采集件时，推荐一定会挑最便宜的那个；
      // 这不是算法问题而是数据可比性问题，界面上要如实说一句。
      marketPicks: [...result.selection.values()]
        .map((id) => state.variants.get(id))
        .filter((variant) => /1688/.test(String(variant?.source || "")))
        .map((variant) => variant.name),
      ms: Math.round(elapsed * 10) / 10,
    };
    return state.rec;
  }

  /** 权重或算法变了就重算；签名没变直接复用上一次结果。 */
  function ensureRecommendation(force = false) {
    const signature = recommendationSignature();
    if (!force && state.rec?.signature === signature) return false;
    optimizeRecommendation(signature);
    return true;
  }

  let recTimer = 0;

  /** 拖权重滑块时防抖重算：先把"重算中"画出去，再跑多起点爬山。 */
  function scheduleRecommendation() {
    clearTimeout(recTimer);
    recTimer = setTimeout(() => {
      recTimer = 0;
      if (ensureRecommendation()) refreshSystemViews();
    }, 260);
  }

  /** 只刷新依赖"系统推荐"的视图，保留矩阵滚动位置。 */
  function refreshSystemViews() {
    const scroll = $("#matrixScroll");
    const left = scroll?.scrollLeft || 0;
    const top = scroll?.scrollTop || 0;
    renderMatrix();
    if (state.inspected?.schemeId === "system") renderInspector();
    renderScore();
    renderCompareState();
    saveState();
    if (scroll) {
      scroll.scrollLeft = left;
      scroll.scrollTop = top;
    }
  }

  function renderScore() {
    const panel = $("#scorePanel");
    if (!panel) return;
    const columns = state.compareMode && canCompare() ? allColumns() : [];
    if (columns.length < 2) {
      panel.hidden = true;
      panel.replaceChildren();
      panel.dataset.signature = "";
      scoreCtx = { columns, signature: "" };
      return;
    }
    const signature = columns.map((column) => column.id).join("|");
    scoreCtx = { columns, signature };
    if (panel.dataset.signature !== signature) buildScoreDom(panel, signature);
    panel.hidden = false;
    paintScore();
  }

  function buildScoreDom(panel, signature) {
    panel.dataset.signature = signature;

    const head = h(
      "div",
      { class: "s2-score-head" },
      h(
        "div",
        {},
        h("span", { class: "kicker", text: "CUSTOM WEIGHTED SCORE" }),
        h("h2", { text: "你的优先级，决定最终排名" }),
      ),
      h("button", {
        class: "secondary-button",
        type: "button",
        id: "scoreReset",
        text: "重置权重",
      }),
    );

    const presets = h("div", { class: "s2-score-presets" }, h("span", { text: "场景预设" }));
    for (const [key, preset] of Object.entries(SCORE_PRESETS)) {
      presets.append(
        h("button", {
          type: "button",
          class: "s2-score-preset",
          "data-preset": key,
          text: preset.label,
        }),
      );
    }

    const controls = h(
      "aside",
      { class: "s2-score-controls" },
      h(
        "div",
        { class: "s2-score-control-head" },
        h("strong", { text: "权重配置" }),
        h("span", { id: "weightTotal", text: "合计 100%" }),
      ),
    );

    const sliders = h("div", { class: "s2-score-sliders" });
    for (const dim of SCORE_DIMS) {
      const output = h("output", { id: `output-${dim.id}` });
      const input = h("input", {
        id: `weight-${dim.id}`,
        type: "range",
        min: "0",
        max: "60",
        step: "5",
        "data-weight": dim.id,
        "aria-label": `${dim.label}权重`,
        oninput: (event) => {
          state.score.weights[dim.id] = Number(event.target.value);
          state.score.preset = "custom";
          paintScore();
          saveState();
          scheduleRecommendation();
        },
      });
      sliders.append(
        h(
          "label",
          { class: "s2-score-slider", for: `weight-${dim.id}` },
          h(
            "span",
            { class: "s2-score-slider-label" },
            h("i", { style: `background:${dim.color}` }),
            h("strong", { text: dim.label }),
            h("small", { text: dim.hint }),
            output,
          ),
          input,
        ),
      );
    }

    controls.append(
      sliders,
      h("p", {
        class: "s2-score-note",
        text: "权重可自由调整，评分时自动归一化；0% 表示该维度不参与评分。",
      }),
      h(
        "div",
        { class: "s2-score-formula" },
        h("span", { text: "SCORING FORMULA" }),
        h("code", { text: "综合得分 = √(Σ 维度得分 × 归一化权重) × 10" }),
        h("small", {
          text: "再按约束封顶：硬约束未满足 ≤ 20，软约束未满足 ≤ 60。",
        }),
      ),
    );

    const results = h(
      "div",
      { class: "s2-score-results" },
      h("div", { class: "s2-score-winner", id: "scoreWinner" }),
      h("div", { class: "s2-score-ranking", id: "scoreRanking" }),
      h("div", { class: "s2-score-legend", id: "scoreLegend" }),
    );

    panel.replaceChildren(
      head,
      presets,
      h("div", { class: "s2-score-engine", id: "scoreEngine", hidden: true }),
      h("div", { class: "s2-score-body" }, controls, results),
    );

    $("#scoreReset", panel).addEventListener("click", () => setScorePreset("balanced"));
    for (const button of $$("[data-preset]", presets)) {
      button.addEventListener("click", () => setScorePreset(button.dataset.preset));
    }
    syncScoreSliders();
  }

  function setScorePreset(key) {
    const preset = SCORE_PRESETS[key];
    if (!preset) return;
    state.score = { preset: key, weights: { ...preset.weights } };
    syncScoreSliders();
    // 权重换了，"最优组合"也会换：立即重算系统推荐，再刷新它影响到的视图。
    if (ensureRecommendation()) refreshSystemViews();
    else {
      paintScore();
      saveState();
    }
    toast(`已切换到「${preset.label}」权重，系统推荐已按新权重重算。`);
  }

  function syncScoreSliders() {
    for (const dim of SCORE_DIMS) {
      const input = $(`#weight-${dim.id}`);
      if (input) input.value = String(Number(state.score.weights[dim.id]) || 0);
    }
  }

  /**
   * 推荐引擎说明条：用的什么算法、试算了多少次、换了哪几件、比全标准件多拿几分。
   * 悬停可以看每一步置换的明细，这样"系统推荐"不是黑箱。
   */
  function paintEngine() {
    const host = $("#scoreEngine");
    if (!host) return;
    const rec = state.rec;
    if (!rec) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const stale = rec.signature !== recommendationSignature();
    host.classList.toggle("is-stale", stale);

    const before = rec.baseline?.score ?? 0;
    const after = rec.current?.score ?? 0;
    const delta = after - before;
    const shapedDelta = (rec.current?.shaped ?? 0) - (rec.baseline?.shaped ?? 0);
    let detail;
    if (rec.method === "enum") {
      detail = `穷举 ${formatCombos(rec.combos)} 个组合（${rec.evals.toLocaleString(
        "zh-CN",
      )} 次试算），取全局最高分`;
    } else if (rec.method === "none") {
      detail = `权重合计为 0，综合得分不成立 · 组合空间 ${formatCombos(rec.combos)}`;
    } else {
      const climbed = (rec.starts || []).filter((start) => !start.skipped);
      const startText = climbed.length
        ? `多起点 ${climbed.length} 路（最优：${rec.bestStart || "—"}）`
        : "单起点";
      detail = `${startText} · 候选 ${rec.poolSize} 个型号 · 组合空间 ${formatCombos(
        rec.combos,
      )} · 试算 ${rec.evals.toLocaleString("zh-CN")} 次 / ${rec.rounds} 轮 · 置换 ${
        rec.steps.length
      } 处`;
    }
    const startLines = (rec.starts || []).map((start) =>
      start.skipped
        ? `${start.label}：起点与前面重复，跳过`
        : `${start.label}：${start.from.toFixed(1)} → ${start.score.toFixed(1)}（${start.steps} 步）`,
    );
    const stepTitle = [
      startLines.length ? `多起点各爬一次，取分数最高的一路：\n${startLines.join("\n")}` : "",
      rec.steps.length
        ? `按涨分从大到小执行，每步至少 +${REC_MIN_GAIN} 分：\n${rec.steps
            .map((step, index) => {
              let outcome;
              if (step.reason === "hard") outcome = "硬约束达标";
              else if (step.reason === "soft") outcome = "软约束达标";
              else if (step.reason === "shaped") outcome = `原始分 +${step.shapedGain.toFixed(2)}（已封顶）`;
              else outcome = `+${step.gain.toFixed(2)} 分`;
              return `${index + 1}. ${step.typeName}：${step.fromName} → ${step.toName}（${outcome}）`;
            })
            .join("\n")}`
        : "全标准件已经是局部最优：任何单件替换都涨不了 0.05 分。",
    ]
      .filter(Boolean)
      .join("\n\n");

    // 涨分标：封顶时显示分不再变化，就改成展示封顶前的原始分涨了多少。
    let badgeText;
    let badgeClass = "";
    if (delta > REC_MIN_GAIN) {
      badgeText = `+${delta.toFixed(1)}`;
      badgeClass = " is-up";
    } else if (Math.abs(delta) <= REC_MIN_GAIN && shapedDelta > REC_MIN_GAIN) {
      badgeText = `原始分 +${shapedDelta.toFixed(1)}（已封顶）`;
      badgeClass = " is-flat";
    } else if (delta < -REC_MIN_GAIN) {
      badgeText = delta.toFixed(1);
    } else {
      badgeText = "持平";
    }

    const nodes = [
      h("span", { class: "s2-engine-tag", text: "推荐引擎" }),
      h(
        "div",
        { class: "s2-engine-copy" },
        h("strong", { text: recMethodLabel() }),
        h("span", { text: detail }),
      ),
      h(
        "div",
        { class: "s2-engine-gain", title: stepTitle },
        h("span", { text: "全标准件" }),
        h("b", { text: before.toFixed(1) }),
        h("span", { class: "s2-engine-arrow", text: "→" }),
        h("span", { text: "系统推荐" }),
        h("b", { text: after.toFixed(1) }),
        h("span", { class: `s2-engine-delta${badgeClass}`, text: badgeText }),
      ),
    ];
    if (stale) nodes.push(h("span", { class: "s2-engine-stale", text: "权重已变，正在重算…" }));
    if (rec.note) nodes.push(h("span", { class: "s2-engine-note", text: rec.note }));
    if (rec.marketPicks?.length) {
      nodes.push(
        h("span", {
          class: "s2-engine-note",
          text: `推荐里有 ${rec.marketPicks.length} 个 1688 采集件（规格可比性待人工确认）：${rec.marketPicks.join("、")}`,
        }),
      );
    }

    host.replaceChildren(...nodes);
  }

  function paintScore() {
    paintEngine();
    const weights = state.score.weights;
    const sum = SCORE_DIMS.reduce((total, dim) => total + (Number(weights[dim.id]) || 0), 0);

    for (const dim of SCORE_DIMS) {
      const value = Number(weights[dim.id]) || 0;
      const output = $(`#output-${dim.id}`);
      if (output) output.textContent = `${value}%`;
      const input = $(`#weight-${dim.id}`);
      if (input) input.value = String(value);
    }

    const total = $("#weightTotal");
    if (total) total.textContent = `合计 ${sum}%`;

    for (const button of $$("#scorePanel [data-preset]")) {
      button.classList.toggle("active", button.dataset.preset === state.score.preset);
    }

    const winner = $("#scoreWinner");
    const ranking = $("#scoreRanking");
    const legend = $("#scoreLegend");
    if (!winner || !ranking || !legend) return;

    legend.replaceChildren();
    for (const dim of SCORE_DIMS) {
      legend.append(
        h(
          "span",
          {},
          h("i", { style: `background:${dim.color}` }),
          `${dim.label} ${Number(weights[dim.id]) || 0}%`,
        ),
      );
    }

    if (sum <= 0) {
      winner.replaceChildren(
        h("div", { class: "s2-score-empty", text: "至少保留一项权重，才能生成评分。" }),
      );
      ranking.replaceChildren();
      return;
    }

    const { columns } = scoreCtx;
    const scored = columns
      .map((column) => ({ column, result: weightedScore(column, weights) }))
      .map((entry) => ({ ...entry, final: finalScore(entry.result.total, entry.column) }))
      .sort((a, b) => b.final.score - a.final.score);

    const top = scored[0];
    const margin = scored.length > 1 ? top.final.score - scored[1].final.score : 0;
    const presetLabel =
      state.score.preset === "custom"
        ? "自定义"
        : SCORE_PRESETS[state.score.preset]?.label || "自定义";
    const strengths = SCORE_DIMS.map((dim) => ({
      label: dim.label,
      value: dimScore(dim, top.column),
    }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 2)
      .map((item) => item.label)
      .join("、");

    winner.replaceChildren(
      h(
        "div",
        { class: "s2-score-winner-copy" },
        h("span", { text: `当前首选 / ${presetLabel}` }),
        h("h3", { text: top.column.name }),
        top.final.capped
          ? h("p", {
              class: "is-capped",
              text: top.final.capKind === "hard"
                ? `硬约束未满足，得分封顶 ${top.final.cap} 分（原始 ${top.final.shaped.toFixed(1)}）。`
                : `软约束未满足，得分封顶 ${top.final.cap} 分（原始 ${top.final.shaped.toFixed(1)}）。`,
            })
          : margin < 0.05
            ? h("p", { text: "与其他方案并列：换个零件或调整权重，就能拉开差距。" })
            : h(
                "p",
                {},
                `优势集中在${strengths}，领先下一名 `,
                h("strong", { text: margin.toFixed(1) }),
                " 分。",
              ),
      ),
      h(
        "div",
        { class: "s2-score-winner-score" },
        h("strong", { text: top.final.score.toFixed(1) }),
        h("span", { text: "/ 100" }),
      ),
    );

    ranking.replaceChildren();
    scored.forEach((entry, index) => {
      const fill = h("div", { class: "s2-score-bar-fill", style: `width:${entry.final.score}%` });
      for (const dim of SCORE_DIMS) {
        const part = entry.result.parts[dim.id] || 0;
        if (part <= 0) continue;
        const share = entry.result.total > 0 ? (part / entry.result.total) * 100 : 0;
        fill.append(
          h("i", {
            style: `width:${share}%;background:${dim.color}`,
            title: `${dim.label}贡献 ${part.toFixed(1)} 分`,
          }),
        );
      }
      ranking.append(
        h(
          "div",
          {
            class: `s2-score-row${index === 0 ? " leader" : ""}${entry.final.capped ? " capped" : ""}`,
          },
          h("div", { class: "s2-score-rank", text: String(index + 1).padStart(2, "0") }),
          h(
            "div",
            { class: "s2-score-scheme" },
            h("strong", { text: entry.column.name }),
            h("span", {
              text: entry.final.capped
                ? `${entry.final.capKind === "hard" ? "硬" : "软"}约束封顶 ${entry.final.cap}`
                : entry.column.system
                  ? `系统推荐 · ${recMethodLabel()}`
                  : "用户自配",
            }),
          ),
          h("div", { class: "s2-score-bar" }, fill),
          h("div", { class: "s2-score-number", text: entry.final.score.toFixed(1) }),
        ),
      );
    });
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：顶部 / 左栏 / 中栏 / 右栏                                      */
  /* ------------------------------------------------------------------ */

  function renderAll() {
    hideTooltip();
    ensureRecommendation();
    renderHeroConstraints();
    renderProject();
    renderActiveBar();
    renderTree();
    renderMatrix();
    renderInspector();
    renderScore();
    renderCompareState();
    // 权重 / 方案一变，交付排期的交期与得分也跟着变，正在看这一屏就重画。
    if (state.tab === "delivery") renderDelivery();
    saveState();  }

  // 把第一页的硬约束直接放到标题位置；每一条都可悬停 / 聚焦查看条件与基线状态。
  function renderHeroConstraints() {
    const host = $("#heroConstraints");
    if (!host) return;
    const constraints = (state.payload?.result?.constraints || []).filter(
      (constraint) => String(constraint.dimension || "").toLowerCase() !== "none",
    );
    state.heroConstraints = constraints;
    host.replaceChildren();
    host.classList.toggle("is-empty", constraints.length === 0);

    if (constraints.length === 0) {
      host.textContent = "本需求未设置硬约束";
      return;
    }

    const nodes = [];
    constraints.forEach((constraint, index) => {
      const soft = constraintIsSoft(constraint);
      nodes.push(
        h(
          "span",
          {
            class: `s2-constraint-phrase${soft ? " is-soft" : ""}`,
            tabindex: "0",
            "data-constraint-index": String(index),
            title: soft ? "软约束：未满足时综合得分封顶 60" : "硬约束：未满足时综合得分封顶 20",
          },
          displayOf(constraint),
          soft ? h("i", { class: "s2-soft-tag", text: "软" }) : null,
        ),
      );
      if (index < constraints.length - 1) {
        nodes.push(h("span", { class: "s2-constraint-sep", "aria-hidden": "true", text: "·" }));
      }
    });
    host.append(...nodes);
  }

  function renderProject() {
    const product = state.payload?.result?.productType;
    const name =
      state.handoffName || state.payload?.projectName || product?.name || "未命名需求";
    const constraints = state.payload?.result?.constraints || [];

    $("#projectName").textContent = name;
    const softCount = constraints.filter((constraint) => constraintIsSoft(constraint)).length;
    const hardCount = constraints.length - softCount;
    $("#projectMeta").textContent = `${product?.code || "h3"} · ${hardCount} 条硬约束${
      softCount > 0 ? ` · ${softCount} 条软约束` : ""
    }${DEMO ? " · 演示数据" : ""}`;
    document.title = `${name} · ATLAS 方案配置`;
  }

  function renderActiveBar() {
    const bar = $("#activeBar");
    const active = activeScheme();
    if (!active) {
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }

    const done = countSelected(active.parts);
    const clear = h("button", { type: "button", text: "清空当前方案" });
    clear.addEventListener("click", () => {
      active.parts = {};
      state.compareMode = false;
      renderAll();
      toast(`已清空 ${active.name}。`);
    });

    bar.hidden = false;
    bar.replaceChildren(
      h("span", { text: "正在编辑" }),
      h("strong", { text: active.name }),
      h("span", { class: "s2-active-progress", text: `${done}/${totalPartTypes()}` }),
      clear,
    );
  }

  /**
   * 表格 / 零件树里的紧凑名字：厂家款有 3 个型号，全名会把型号截掉，
   * 所以矩阵里显示「类型 · 厂家简称-型号尾号」，全名留给详情与悬停。
   */
  function shortNameOf(variant, fallbackTypeName = "") {
    if (!variant) return "";
    if (variant.tierKey !== "market") return variant.name;
    const typeName =
      variant.typeName || state.partTypes.get(variant.typeCode)?.name || fallbackTypeName || "";
    const maker = String(variant.manufacturer || "").slice(0, 2);
    const tail = String(variant.model || "").split("-").pop();
    return typeName && maker ? `${typeName} · ${maker}-${tail}` : variant.name;
  }

  function renderTree() {
    const tree = $("#partTree");
    const active = activeScheme();
    tree.replaceChildren();

    for (const module of state.modules) {
      const section = h("section", { class: "s2-module" });
      let moduleDone = 0;
      for (const part of module.parts) {
        if (active?.parts[part.code]) moduleDone += 1;
      }

      section.append(
        h(
          "header",
          { class: "s2-module-head" },
          h("span", {
            class: "s2-module-index",
            text: String(module.index || 0).padStart(2, "0"),
          }),
          h("strong", { text: module.name }),
          h("span", {
            class: "s2-module-progress",
            text: `${moduleDone}/${module.parts.length}`,
          }),
        ),
      );

      for (const part of module.parts) {
        const type = state.partTypes.get(part.code);
        const selectedId = active?.parts[part.code] || null;
        const selected = selectedId ? state.variants.get(selectedId) : null;
        const expanded = state.expandedType === part.code;

        const toggle = h("button", {
          type: "button",
          class: `s2-type-toggle${expanded ? " expanded" : ""}`,
          "data-type-toggle": part.code,
          "aria-expanded": String(expanded),
        });
        toggle.append(
          h("span", { class: "s2-type-name", text: part.name }),
          h("span", {
            class: `s2-type-current${selected ? " filled" : ""}`,
            text: selected ? shortNameOf(selected) : "未选择",
          }),
          h("span", { class: "s2-type-chevron", text: "›" }),
        );
        section.append(toggle);

        if (expanded) {
          const list = h("div", { class: "s2-variants" });
          for (const variant of type.variants) {
            const isSelected = selectedId === variant.id;
            const card = h("div", {
              class: `s2-variant${isSelected ? " selected" : ""}`,
              "data-variant-id": variant.id,
            });
            const main = h("button", {
              type: "button",
              class: "s2-variant-main",
              "data-inspect-variant": variant.id,
            });
            main.append(
              h(
                "span",
                { class: "s2-variant-name" },
                h("span", { class: "s2-tier", text: variant.tier }),
                shortNameOf(variant, type.name),
              ),
              h("span", {
                class: "s2-variant-meta",
                text: `¥${variant.price.toLocaleString("zh-CN")} · ${variant.weight} g · 性能 ${
          Math.round(variant.performance || 0)
        }`,
              }),
            );
            const add = h("button", {
              type: "button",
              class: "s2-add",
              "data-add-variant": variant.id,
              "data-add-type": type.code,
              "data-selected": isSelected ? "1" : "0",
              text: isSelected ? "取消" : "加入",
            });
            card.append(main, add);
            list.append(card);
          }
          section.append(list);
        }
      }

      tree.append(section);
    }

    $("#treeSummary").textContent = `${totalPartTypes()} 个零件类型 · ${state.schemes.length} 个用户方案`;
  }

  function warnBadge(violations) {
    const tip = `不满足硬条件：${violations.map((item) => item.display).join("；")}`;
    return h("span", { class: "s2-warn", "data-tip": tip, text: "!" });
  }

  function softBadge(violations) {
    const tip = `未达软约束（得分封顶 60）：${violations.map((item) => item.display).join("；")}`;
    return h("span", { class: "s2-warn is-soft", "data-tip": tip, text: "~" });
  }

  function hardViolations(column) {
    return (column.check?.violations || []).filter((item) => !item.soft);
  }

  function softViolations(column) {
    return (column.check?.violations || []).filter((item) => item.soft);
  }

  function constraintBadges(column) {
    const hard = hardViolations(column);
    if (hard.length > 0) return [warnBadge(hard)];
    const soft = softViolations(column);
    if (soft.length > 0) return [softBadge(soft)];
    return [];
  }

  function allColumns() {
    const columns = [];
    const systemTotal = totalsFor(state.system);
    columns.push({
      id: "system",
      name: "系统推荐",
      system: true,
      parts: state.system,
      complete: true,
      total: systemTotal,
      check: evaluateConstraints(systemTotal),
    });

    for (const scheme of state.schemes) {
      const complete = isComplete(scheme);
      const total = totalsFor(scheme.parts);
      columns.push({
        id: scheme.id,
        name: scheme.name,
        system: false,
        parts: scheme.parts,
        complete,
        total,
        check: complete
          ? evaluateConstraints(total)
          : { violations: [], unsupported: [], checked: 0, total: 0 },
      });
    }
    return columns;
  }

  function matrixMetrics(count) {
    const scroller = $("#matrix")?.closest(".s2-matrix-scroll");
    const available = Math.max(scroller ? scroller.clientWidth : 0, 560);
    const columnCount = Math.max(1, count);
    const schemeMin = columnCount * SCHEME_COL_WIDTH;
    let tableWidth = Math.max(available, TYPE_COL_MIN + schemeMin);
    let typeWidth = Math.min(
      TYPE_COL_MAX,
      Math.max(TYPE_COL_MIN, Math.round(tableWidth * TYPE_COL_RATIO)),
    );
    if (tableWidth - typeWidth < schemeMin) tableWidth = typeWidth + schemeMin;
    return {
      tableWidth,
      typeWidth,
      schemeWidth: (tableWidth - typeWidth) / columnCount,
    };
  }

  function renderMatrix() {
    const table = $("#matrix");
    const columns = allColumns();
    const { tableWidth, typeWidth, schemeWidth } = matrixMetrics(columns.length);
    table.classList.toggle("compare", state.compareMode);
    table.style.width = `${tableWidth}px`;
    table.replaceChildren();

    const colgroup = document.createElement("colgroup");
    colgroup.append(h("col", { style: `width:${typeWidth}px` }));
    for (const column of columns) {
      colgroup.append(h("col", { style: `width:${schemeWidth}px` }));
    }
    table.append(colgroup);

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.append(
      h(
        "th",
        { class: "s2-corner", scope: "col" },
        h("span", { class: "s2-corner-label", text: "PARTS" }),
        h("span", { class: "s2-corner-hint", text: "零件类型" }),
      ),
    );

    for (const column of columns) {
      headRow.append(buildColumnHeader(column));
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement("tbody");
    for (const module of state.modules) {
      const moduleRow = document.createElement("tr");
      moduleRow.className = "module-row";
      const moduleCell = h("th", { colspan: String(columns.length + 1) });
      moduleCell.append(
        h("span", { text: String(module.index || 0).padStart(2, "0") }),
        module.name,
      );
      moduleRow.append(moduleCell);
      tbody.append(moduleRow);

      for (const part of module.parts) {
        const row = document.createElement("tr");
        const typeCell = h("th", {
          class: "s2-type",
          scope: "row",
          title: `${part.name} · ${part.code} ×${part.qty}`,
        });
        typeCell.append(
          h(
            "span",
            { class: "s2-type-name", text: part.name },
            Number(part.qty) > 1
              ? h("em", { class: "s2-type-qty", text: `×${part.qty}` })
              : null,
          ),
        );
        row.append(typeCell);

        const isDiff = state.compareMode && diffForType(part.code);
        for (const column of columns) {
          const variantId = variantIdOf(column.parts, part.code);
          const variant = variantId ? state.variants.get(variantId) : null;
          const cell = h("td", {
            class: `s2-cell${column.system ? " is-system" : " editable"}${
              isDiff ? " is-diff" : ""
            }`,
            "data-type-code": part.code,
            "data-scheme-id": column.id,
            ...(variantId ? { "data-variant-id": variantId } : {}),
          });
          if (variant) {
            // 系统推荐里被换成非标准件的格子，点一个圆点并标色，方便看清推荐改了什么。
            const optimized = column.system && variant.tierKey !== "std";
            cell.append(
              h(
                "span",
                { class: "s2-cell-name" },
                optimized ? h("i", { class: "s2-cell-dot" }) : null,
                shortNameOf(variant),
              ),
            );
            cell.title = `${variant.name}${
              variant.manufacturer ? ` · ${variant.manufacturer}` : ""
            }${variant.model ? ` · ${variant.model}` : ""} · 性能 ${Math.round(
              Number(variant.performance) || 0,
            )} · ${variant.risk}风险${optimized ? "（系统推荐换成了非标准件）" : ""}`;
            if (optimized) cell.classList.add("is-optimized");
          } else {
            cell.append(h("span", { class: "s2-cell-empty", text: "未选择" }));
          }
          cell.addEventListener("click", () => {
            if (column.system) {
              if (variantId) inspectVariant(variantId, "system");
              return;
            }
            openTypeForScheme(column.id, part.code);
          });
          row.append(cell);
        }
        tbody.append(row);
      }
    }
    table.append(tbody);

    const tfoot = document.createElement("tfoot");
    const footRow = document.createElement("tr");
    footRow.append(h("th", { scope: "row", title: "合计 / 硬条件", text: "合计" }));
    for (const column of columns) {
      const cell = h("td", { class: column.system ? "is-system" : "" });
      if (column.complete) {
        cell.append(
          h("strong", {
            text: `${fmtMoney(column.total.price)} · ${fmtWeight(column.total.weight)}`,
          }),
          h("span", {
            text: `${fmtLead(column.total.lead)} · ${
              hardViolations(column).length
                ? `硬伤 ${hardViolations(column).length} 条`
                : softViolations(column).length
                  ? `软约束 ${softViolations(column).length} 条未达`
                  : "硬条件通过"
            }`,
          }),
        );
      } else {
        cell.append(
          h("strong", { text: "—" }),
          h("span", { text: `未完成 ${countSelected(column.parts)}/${totalPartTypes()}` }),
        );
      }
      footRow.append(cell);
    }
    tfoot.append(footRow);
    table.append(tfoot);
    requestAnimationFrame(updateMatrixWidth);
  }

  function updateMatrixWidth() {
    const table = $("#matrix");
    if (!table) return;
    const schemeCount = table.querySelectorAll("thead th.s2-col").length;
    if (!schemeCount) return;
    const { tableWidth, typeWidth, schemeWidth } = matrixMetrics(schemeCount);
    table.style.width = `${tableWidth}px`;
    const cols = table.querySelectorAll("colgroup col");
    if (cols.length !== schemeCount + 1) return;
    cols[0].style.width = `${typeWidth}px`;
    for (let index = 1; index < cols.length; index += 1) {
      cols[index].style.width = `${schemeWidth}px`;
    }
  }

  function buildColumnHeader(column) {
    const th = h("th", {
      class: `s2-col${column.system ? " is-system" : ""}${
        column.id === state.activeSchemeId ? " is-active" : ""
      }`,
      scope: "col",
    });
    if (column.system && state.rec) {
      th.title =
        state.rec.method === "enum"
          ? "系统推荐：穷举全部组合取全局最高分"
          : `系统推荐：全标准件起步、每次换涨分最多的一件（共 ${state.rec.steps.length} 处置换）`;
    }

    const title = h("div", { class: "s2-col-title" });
    title.append(h("span", { text: column.name }));
    if (column.system) {
      title.append(h("span", { class: "s2-lock", text: "只读" }));
    } else {
      const remove = h("button", {
        type: "button",
        class: "s2-remove",
        "data-remove-scheme": column.id,
        "aria-label": `删除 ${column.name}`,
        text: "×",
      });
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeScheme(column.id);
      });
      title.append(remove);
      th.addEventListener("click", () => selectScheme(column.id));
    }

    for (const badge of constraintBadges(column)) title.append(badge);

    const meta = h("div", { class: "s2-col-meta" });
    if (column.complete) {
      meta.append(
        h("span", { class: "s2-money", text: fmtMoney(column.total.price) }),
        " · ",
        fmtWeight(column.total.weight),
      );
    } else {
      meta.textContent = `${countSelected(column.parts)}/${totalPartTypes()} · 未完成`;
    }

    const done = countSelected(column.parts);
    const progress = h(
      "div",
      { class: `s2-col-progress${column.complete ? "" : " incomplete"}` },
      h("i", { style: `width:${Math.round((done / totalPartTypes()) * 100)}%` }),
    );

    th.append(title, meta, progress);
    return th;
  }

  // 28 张零件类别示意图：文件名 = 零件类型代码，同类 10 个型号共用一张。
  const PART_ART_BASE = "./data/parts/";

  function partArtUrl(typeCode) {
    return `${PART_ART_BASE}${typeCode}.svg`;
  }

  function partPlateOf(typeCode) {
    let index = 0;
    for (const code of state.partTypes.keys()) {
      index += 1;
      if (code === typeCode) return index;
    }
    return 0;
  }

  function renderInspector() {
    const inspector = $("#inspector");
    const inspected = state.inspected;
    const variant = inspected ? state.variants.get(inspected.variantId) : null;

    if (!variant) {
      inspector.replaceChildren(
        h(
          "div",
          { class: "s2-inspector-empty" },
          h("strong", { text: "选择一个零件" }),
          h("span", {
            text: "从左侧展开零件类型，或点击对比表里的格子，查看零件示意图、核心参数与交期。",
          }),
        ),
      );
      return;
    }

    const type = state.partTypes.get(variant.typeCode);

    const head = h("div", { class: "s2-inspector-head" });
    head.append(
      h("span", { class: "kicker", text: "PART DETAIL" }),
      h("h2", { text: variant.name }),
      h("span", { class: "s2-inspector-code", text: `${type.code} / ${variant.id}` }),
    );

    const badges = h("div", { class: "s2-inspector-badges" });
    badges.append(
      h("span", { class: "s2-chip accent", text: variant.tier }),
      h("span", { class: "s2-chip", text: type.moduleName }),
      h("span", { class: "s2-chip", text: `${variant.risk}风险` }),
    );

    // 每个零件类别一张示意图（28 张），同类 10 个型号共用同一张，见 data/parts/。
    const plate = partPlateOf(type.code);
    const art = h(
      "figure",
      { class: "s2-part-art" },
      h("img", {
        src: partArtUrl(type.code),
        alt: `${type.name}示意图`,
        loading: "lazy",
        draggable: "false",
        onerror: () => art.classList.add("is-missing"),
      }),
      h(
        "figcaption",
        {},
        h("span", { text: type.name }),
        h("small", {
          text: `PART ${String(plate).padStart(2, "0")} / 28 · 同类型号共用一张`,
        }),
      ),
    );

    const details = h("dl", { class: "s2-detail-list" });
    const rows = [
      ["所属模块", type.moduleName],
      ["零件类型", type.name],
      ...(variant.manufacturer ? [["生产厂家", variant.manufacturer]] : []),
      ...(variant.model ? [["零件型号", variant.model]] : []),
      ["用量", `×${type.qty}`],
      ["材料 / 类型", variant.material || "—"],
      ["关键规格", variant.spec || "—"],
      // 挑出来衡量性能的 3 个核心参数，性能分就是把它们归一化后加权的结果。
      ...(variant.coreParams || []).map((param) => [param.label, param.value]),
      ["性能分", `${(Number(variant.performance) || 0).toFixed(1)} / 100`],
      ["原型单价", fmtMoney(variant.price)],
      ["单件重量", fmtWeight(variant.weight)],
      ["采购交期", fmtLead(variant.leadTime)],
      ["风险等级", `${variant.risk}风险`],
      ["风险分", `${variantRiskOf(variant).toFixed(0)} / 100（含交期，越低越好）`],
      ["责任人", variant.owner || "—"],
    ];
    for (const [label, value] of rows) {
      details.append(
        h("div", { class: "s2-detail-row" }, h("dt", { text: label }), h("dd", { text: value })),
      );
    }

    const action = h("button", { type: "button", class: "primary-button s2-inspector-action" });
    const active = activeScheme();

    if (inspected.schemeId === "system") {
      action.disabled = true;
      action.textContent = "系统推荐不可修改";
    } else if (!active) {
      action.disabled = true;
      action.textContent = "先创建一个用户自配方案";
    } else if (active.parts[variant.typeCode] === variant.id) {
      action.textContent = `从 ${active.name} 移除`;
      action.addEventListener("click", () => removeVariant(variant.typeCode));
    } else {
      action.textContent = `加入 ${active.name}`;
      action.addEventListener("click", () => addVariant(variant.typeCode, variant.id));
    }

    inspector.replaceChildren(
      head,
      badges,
      art,
      details,
      h("p", { class: "s2-desc", text: variant.description || "" }),
      action,
    );
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：对比门槛与结果                                                */
  /* ------------------------------------------------------------------ */

  function renderCompareState() {
    const button = $("#compareBtn");
    const hint = $("#compareHint");
    const summary = $("#compareSummary");
    const incomplete = state.schemes.filter((scheme) => !isComplete(scheme));

    hint.classList.remove("warn");

    if (state.schemes.length === 0) {
      button.disabled = true;
      button.textContent = "开始对比";
      hint.textContent = "先创建一个用户自配方案";
    } else if (incomplete.length > 0) {
      const missing = incomplete.reduce(
        (total, scheme) => total + (totalPartTypes() - countSelected(scheme.parts)),
        0,
      );
      button.disabled = true;
      button.textContent = "开始对比";
      hint.classList.add("warn");
      hint.textContent = `还有 ${missing} 个零件未填：${incomplete
        .map((scheme) => scheme.name)
        .join("、")}`;
    } else {
      button.disabled = false;
      button.textContent = state.compareMode ? "重新对比" : "开始对比";
      hint.textContent = state.compareMode ? "对比已刷新" : "所有用户方案已填满，可以开始对比";
    }

    if (!state.compareMode || !canCompare()) {
      summary.hidden = true;
      summary.replaceChildren();
      return;
    }

    summary.hidden = false;
    const columns = allColumns();
    const unsupported = [...new Set(columns.flatMap((column) => column.check.unsupported))];

    const head = h(
      "div",
      { class: "s2-summary-head" },
      h("strong", { text: "对比结果" }),
      h("span", {
        text: `${columns.length} 个方案 · 差异零件 ${diffCount()} 项`,
      }),
    );

    const grid = h("div", { class: "s2-summary-grid" });
    for (const column of columns) {
      const card = h("article", {
        class: `s2-summary-card${column.system ? " is-system" : ""}${
          hardViolations(column).length
            ? " has-violation"
            : softViolations(column).length
              ? " has-soft"
              : ""
        }`,
      });
      const cardHead = h("header");
      cardHead.append(
        h("strong", { text: column.name }),
        h("small", {
          text: column.system ? `系统推荐 · ${recMethodLabel()}` : "用户自配",
        }),
      );
      if (column.check.violations.length > 0) {
        cardHead.append(...constraintBadges(column));
      }
      card.append(cardHead);
      card.append(
        summaryLine("BOM 成本", fmtMoney(column.total.price)),
        summaryLine("整机重量", fmtWeight(column.total.weight)),
        summaryLine("综合性能", `${performanceOf(column.parts).toFixed(1)} / 100`),
        summaryLine("风险分（含交期）", `${riskIndex(column).toFixed(0)} · 最长交期 ${fmtLead(column.total.lead)}`),
      );

      const scored = finalScore(
        weightedScore(column, state.score.weights).total,
        column,
      );
      if (scored && scored.score > 0) {
        card.append(
          h(
            "div",
            { class: "s2-summary-line is-score" },
            h("span", { text: "综合评分" }),
            h("b", {
              text: scored.score.toFixed(1),
              title: scored.capped
                ? `受${scored.capKind === "hard" ? "硬" : "软"}约束封顶（原始 ${scored.shaped.toFixed(1)}）`
                : "",
            }),
          ),
        );
      }

      const hard = hardViolations(column);
      const soft = softViolations(column);

      if (hard.length > 0) {
        const list = h("ul", { class: "s2-summary-violations" });
        for (const violation of hard) {
          list.append(
            h("li", { text: `${violation.display}（当前 ${violation.actualText}）` }),
          );
        }
        if (soft.length > 0) {
          list.append(
            h("li", {
              class: "is-soft",
              text: `另有 ${soft.length} 条软约束未达`,
            }),
          );
        }
        card.append(list);
      } else if (soft.length > 0) {
        const list = h("ul", { class: "s2-summary-violations is-soft" });
        for (const violation of soft) {
          list.append(
            h("li", { text: `软约束 ${violation.display}（当前 ${violation.actualText}）` }),
          );
        }
        card.append(list);
      } else {
        card.append(
          h("p", {
            class: "s2-summary-ok",
            text:
              column.check.total === 0
                ? "未设置硬性约束"
                : column.check.checked === 0
                  ? "硬条件需人工确认"
                  : `硬条件通过（已校验 ${column.check.checked} 条）`,
          }),
        );
      }
      grid.append(card);
    }

    summary.replaceChildren(head, grid);
    if (unsupported.length > 0) {
      summary.append(
        h("p", {
          class: "s2-summary-note",
          text: `未能从零件数据自动校验：${unsupported.join("、")}（需人工确认）`,
        }),
      );
    }
  }

  function summaryLine(label, value) {
    return h(
      "div",
      { class: "s2-summary-line" },
      h("span", { text: label }),
      h("b", { text: value }),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 操作                                                                */
  /* ------------------------------------------------------------------ */

  function createScheme(mode) {
    state.schemeSeq += 1;
    const id = `u${Date.now().toString(36)}${state.schemeSeq}`;
    const parts = {};
    if (mode === "system") {
      for (const [typeCode, variantId] of state.system) parts[typeCode] = variantId;
    }

    const scheme = {
      id,
      name: "",
      mode,
      parts,
    };
    state.schemes.push(scheme);
    renumberSchemes();
    state.activeSchemeId = id;
    state.compareMode = false;
    state.expandedType = mode === "zero" ? [...state.partTypes.keys()][0] ?? null : null;

    const firstType = [...state.partTypes.values()][0];
    state.inspected = firstType
      ? {
          variantId: parts[firstType.code] || firstType.baselineVariantId,
          schemeId: id,
        }
      : null;

    renderAll();
    if (mode === "system") {
      toast(`已从系统推荐创建 ${scheme.name}，可以逐项替换。`);
    } else {
      toast(`已创建 ${scheme.name}，从左侧逐项加入零件。`);
    }
    scrollMatrixToEnd();
  }

  function addVariant(typeCode, variantId) {
    const active = activeScheme();
    if (!active) {
      toast("先创建一个用户自配方案。");
      return;
    }
    const variant = state.variants.get(variantId);
    if (!variant || variant.typeCode !== typeCode) return;

    active.parts[typeCode] = variantId;
    state.inspected = { variantId, schemeId: active.id };
    state.compareMode = false;
    renderAll();
    toast(`已加入 ${active.name}：${variant.name}`);
  }

  function removeVariant(typeCode) {
    const active = activeScheme();
    if (!active || !active.parts[typeCode]) {
      toast("该零件还没有加入当前方案。");
      return;
    }
    const type = state.partTypes.get(typeCode);
    delete active.parts[typeCode];
    state.compareMode = false;
    state.inspected = {
      variantId: type?.baselineVariantId,
      schemeId: active.id,
    };
    renderAll();
    toast(`已从 ${active.name} 移除 ${type?.name || "零件"}。`);
  }

  function selectScheme(id) {
    if (!schemeById(id)) return;
    state.activeSchemeId = id;
    renderAll();
  }

  function removeScheme(id) {
    const index = state.schemes.findIndex((scheme) => scheme.id === id);
    if (index === -1) return;
    const [removed] = state.schemes.splice(index, 1);
    renumberSchemes();
    if (state.activeSchemeId === id) {
      state.activeSchemeId = state.schemes[index]?.id ?? state.schemes[index - 1]?.id ?? null;
    }
    if (state.inspected?.schemeId === id) state.inspected = defaultInspection();
    state.compareMode = false;
    renderAll();
    toast(`已删除 ${removed.name}。`);
  }

  function openTypeForScheme(schemeId, typeCode) {
    const scheme = schemeById(schemeId);
    if (!scheme) return;
    state.activeSchemeId = schemeId;
    state.expandedType = typeCode;
    const selected = scheme.parts[typeCode];
    const type = state.partTypes.get(typeCode);
    state.inspected = {
      variantId: selected || type?.baselineVariantId,
      schemeId,
    };
    renderAll();
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-type-toggle="${typeCode}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function inspectVariant(variantId, schemeId) {
    const variant = state.variants.get(variantId);
    if (!variant) return;
    if (schemeId && schemeId !== "system" && schemeById(schemeId)) {
      state.activeSchemeId = schemeId;
    }
    state.inspected = { variantId, schemeId: schemeId || "system" };
    renderActiveBar();
    renderMatrix();
    renderInspector();
    saveState();
  }

  function resetSchemes() {
    if (state.schemes.length === 0 && !state.compareMode) {
      toast("当前没有用户自配方案。");
      return;
    }
    state.schemes = [];
    state.schemeSeq = 0;
    state.activeSchemeId = null;
    state.expandedType = null;
    state.compareMode = false;
    state.inspected = defaultInspection();
    try {
      sessionStorage.removeItem(state.storageKey);
    } catch {
      /* ignore */
    }
    renderAll();
    toast("已清空用户自配方案。");
  }

  function armReset() {
    const button = $("#resetBtn");
    if (!state.resetArmed) {
      state.resetArmed = true;
      button.textContent = "再点一次确认";
      button.classList.add("armed");
      clearTimeout(state.resetTimer);
      state.resetTimer = setTimeout(() => {
        state.resetArmed = false;
        button.textContent = "重置自配";
        button.classList.remove("armed");
      }, 3200);
      return;
    }
    clearTimeout(state.resetTimer);
    state.resetArmed = false;
    button.textContent = "重置自配";
    button.classList.remove("armed");
    resetSchemes();
  }

  function scrollMatrixToEnd() {
    const scroll = $("#matrixScroll");
    if (!scroll) return;
    requestAnimationFrame(() => {
      scroll.scrollLeft = scroll.scrollWidth;
    });
  }

  /* ------------------------------------------------------------------ */
  /* 交付排期：甘特图 + 配套流程图                                        */
  /*                                                                     */
  /* 原来拆成两屏「周期风险」和「人员协作」，其实是一件事：按交期倒排、     */
  /* 谁在什么时候做什么。合并后一屏里放两张同源的图：                     */
  /*   1. 甘特图 —— 任务 × 时间，条形长度 = 交期/工期，红色虚线 = 预警线； */
  /*   2. 流程图 —— 任务 × 依赖，箭头从左往右，AI 单独一条带。            */
  /* 两张图的日期都来自同一个 deliveryPlan()，不存在各画各的。             */
  /*                                                                     */
  /* 排期规则（全部由「最佳方案里每个零件的交期」推出来，没有手填数字）：   */
  /*   采购：7 个模块组各自从第 0 天下单，到料日 = 组内最晚零件交期；       */
  /*   轴系组装：等俯仰/横滚/航向/手柄 4 组齐套后开工；                     */
  /*   电气总装：等轴系组装完成后，且相机/控制/电源 3 组到料；              */
  /*   整机检查：总装完成后开工；                                          */
  /*   AI 三条：到料预测贯穿采购、装配排程在轴系开工前、视觉检测与检查并行。*/
  /* 用户只改日期窗：条形位置不动（交期算出来的），刻度、余量、超窗提示跟着变。*/
  /* ------------------------------------------------------------------ */

  const DLV_LANES = [
    { id: "ai", owner: "AI", name: "AI 赋能", color: "#b39dfb", note: "预测 · 排程 · 检测" },
    { id: "buy", owner: "周予", name: "采购", color: "#60a5fa", note: "供应链 / 到料" },
    { id: "build", owner: "陈屿", name: "装配", color: "#f2b880", note: "结构 / 总装" },
    { id: "test", owner: "苏航", name: "检查", color: "#6ee7d0", note: "整机验收" },
  ];
  const DLV_LANE_BY_ID = new Map(DLV_LANES.map((lane) => [lane.id, lane]));

  // 两道装配 + 一道检查 = 7 组采购之外的非 AI 任务，共 10 项。
  const DLV_STAGES = [
    {
      id: "asm1",
      lane: "build",
      name: "轴系与手柄结构组装",
      short: "轴系组装",
      groups: ["h3-pit", "h3-rol", "h3-yaw", "h3-hnd"],
      days: 3,
      gate: "G1",
    },
    {
      id: "asm2",
      lane: "build",
      name: "电气总装与整机集成",
      short: "电气总装",
      groups: ["h3-cam", "h3-ctl", "h3-pwr"],
      days: 3,
      gate: "G2",
    },
    {
      id: "qa",
      lane: "test",
      name: "整机检查与验收",
      short: "整机检查",
      groups: [],
      days: 2,
      gate: "G3",
    },
  ];

  const DLV_ALERT_LEVELS = {
    info: { label: "节点", color: "#60a5fa" },
    warn: { label: "预警", color: "#f2b880" },
    risk: { label: "延期", color: "#ff8080" },
  };

  const DLV_DAY_MS = 86400000;

  function dlvParse(iso) {
    const [year, month, day] = String(iso).split("-").map(Number);
    return new Date(year, (month || 1) - 1, day || 1);
  }

  function dlvIso(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`;
  }

  function dlvShift(iso, days) {
    const date = dlvParse(iso);
    date.setDate(date.getDate() + days);
    return dlvIso(date);
  }

  function dlvDiff(from, to) {
    return Math.round((dlvParse(to) - dlvParse(from)) / DLV_DAY_MS);
  }

  function dlvMonthDay(iso) {
    const date = dlvParse(iso);
    return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(
      2,
      "0",
    )}`;
  }

  function dlvWeekdayLabel(iso) {
    return "日一二三四五六"[dlvParse(iso).getDay()];
  }

  // 默认从"下一个周一"开工：给评审留出下发的余地，也让日历刻度好读。
  function dlvDefaultStart() {
    const today = new Date();
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const ahead = (8 - date.getDay()) % 7 || 7;
    date.setDate(date.getDate() + ahead);
    return dlvIso(date);
  }

  function dlvStageOf(moduleCode) {
    const stage = DLV_STAGES.find((item) => item.groups.includes(moduleCode));
    return stage ? stage.id : "asm2";
  }

  /** 候选方案按当前权重下的最终得分排序：排期默认用第一名，也就是"最佳方案"。 */
  function dlvColumns() {
    return allColumns()
      .filter((column) => column.complete)
      .map((column) => ({ ...column, final: finalScore(rawScoreFor(column), column) }))
      .sort((a, b) => b.final.score - a.final.score);
  }

  function dlvBasisOf(columns) {
    const wanted = state.delivery.basisId;
    return columns.find((column) => column.id === wanted) || columns[0] || null;
  }

  function dlvGroups(parts) {
    return state.modules.map((module) => {
      const rows = module.parts
        .map((type) => {
          const variantId = variantIdOf(parts, type.code);
          const variant = variantId ? state.variants.get(variantId) : null;
          return variant
            ? {
                typeCode: type.code,
                typeName: type.name,
                qty: type.qty,
                variant,
              }
            : null;
        })
        .filter(Boolean);
      const lead = rows.reduce((max, row) => Math.max(max, Number(row.variant.leadTime) || 0), 0);
      return {
        code: module.code,
        name: module.name,
        index: module.index,
        rows,
        lead,
        high: rows.filter((row) => row.variant.risk === "高").length,
        stage: dlvStageOf(module.code),
      };
    });
  }

  /** 按"每组到料日"往前推各道工序的起止；返回的 stage 里带 codes。 */
  function dlvStageTimes(groupByCode, arrivalOf) {
    const stages = [];
    let cursor = 0;
    for (const stage of DLV_STAGES) {
      const codes = stage.groups.filter((code) => groupByCode.has(code));
      const ready = codes.length ? Math.max(...codes.map((code) => arrivalOf(code))) : 0;
      const s = Math.max(ready, cursor);
      const e = s + stage.days - 1;
      cursor = e + 1;
      stages.push({ ...stage, codes, ready, s, e });
    }
    return stages;
  }

  /**
   * 把 7 张采购单铺到"半天工位"上：一个人同一时刻只干一件事，所以一单占半天、绝不重叠。
   * 最紧的几张（交期把最晚下单日顶到前两天的）先按 0、0.5、1、1.5 天依次落座 —— 一天两单，
   * 上午一单下午一单；其余的在自己最晚下单日之前尽量均匀铺开，并让开已经占用的到料日。
   * 最晚下单槽位 = 该组所在工序最晚开工日 − 交期（按半天取整），超过它就会把总时长顶长。
   */
  function dlvLevelOrders(groups, deadlineOf) {
    const latestSlotOf = (group) =>
      Math.max(0, 2 * (deadlineOf(group.code) - group.lead) + 1);
    const ordered = [...groups].sort(
      (a, b) => latestSlotOf(a) - latestSlotOf(b) || b.lead - a.lead || a.index - b.index,
    );
    const slots = new Map();
    const used = new Set();
    const arriveUse = new Map();
    const take = (group, slot) => {
      used.add(slot);
      const start = slot / 2;
      const arrive = Math.floor(start) + group.lead;
      arriveUse.set(arrive, (arriveUse.get(arrive) || 0) + 1);
      slots.set(group.code, {
        slot,
        start,
        end: start + 0.5,
        arrive,
        latest: latestSlotOf(group),
      });
    };

    let cursor = 0;
    const flexible = [];
    for (const group of ordered) {
      const latest = latestSlotOf(group);
      if (latest > 3) {
        flexible.push(group);
        continue;
      }
      while (used.has(cursor)) cursor += 1;
      take(group, Math.min(cursor, latest));
    }

    let last = used.size ? Math.max(...used) : 0;
    flexible.sort((a, b) => latestSlotOf(a) - latestSlotOf(b));
    flexible.forEach((group, index) => {
      const latest = latestSlotOf(group);
      const ideal = last + ((latest - last) * (index + 1)) / (flexible.length + 1);
      let best = null;
      for (let slot = last + 1; slot <= latest; slot += 1) {
        if (used.has(slot)) continue;
        const arrive = Math.floor(slot / 2) + group.lead;
        const dup = arriveUse.get(arrive) || 0;
        const cost = Math.abs(slot - ideal) * 2 + dup * 16;
        if (!best || cost < best.cost) best = { slot, cost };
      }
      take(group, best ? best.slot : latest);
      last = Math.max(last, best ? best.slot : latest);
    });
    return slots;
  }

  function dlvEndOf(task) {
    return typeof task.end === "number" ? task.end : task.e + 1;
  }

  /** 统计"同时开工 / 同时收尾"的拥挤程度：max 是同一时刻最多几项，extra 是多出来的总数。 */
  function dlvCollisions(tasks) {
    const starts = new Map();
    const ends = new Map();
    for (const task of tasks) {
      starts.set(task.s, (starts.get(task.s) || 0) + 1);
      const end = dlvEndOf(task);
      ends.set(end, (ends.get(end) || 0) + 1);
    }
    const tally = (map) => {
      let max = 0;
      let extra = 0;
      for (const count of map.values()) {
        max = Math.max(max, count);
        extra += Math.max(0, count - 1);
      }
      return { max, extra };
    };
    const start = tally(starts);
    const end = tally(ends);
    return { maxStart: start.max, maxEnd: end.max, extraStart: start.extra, extraEnd: end.extra };
  }

  /** 同一名工程师有几处任务在时间上压住（AI 是不同模型服务，不算人）。目标恒为 0。 */
  function dlvPersonOverlap(tasks) {
    const byLane = new Map();
    for (const task of tasks) {
      if (task.lane === "ai") continue;
      const list = byLane.get(task.lane) || [];
      list.push([task.s, dlvEndOf(task)]);
      byLane.set(task.lane, list);
    }
    let overlap = 0;
    for (const list of byLane.values()) {
      list.sort((a, b) => a[0] - b[0]);
      let reach = -Infinity;
      for (const [start, end] of list) {
        if (start < reach - 1e-9) overlap += 1;
        reach = Math.max(reach, end);
      }
    }
    return overlap;
  }

  /** AI 三条任务的落点候选：挑"同时开工 + 同时收尾"最少的一组。 */
  function dlvPickAiWindows({ base, asm1, qa, lastArrival, limit }) {
    const cap = Math.max(1, limit);
    const forecastEnds = [lastArrival, lastArrival + 1, lastArrival + 2].map((day) =>
      Math.min(Math.max(day, 1), cap),
    );
    const planWindows = [
      [Math.max(0, asm1.s - 2), Math.max(1, asm1.s - 1)],
      [Math.max(0, asm1.s - 3), Math.max(1, asm1.s - 2)],
    ];
    const visionWindows = [
      [qa.s, qa.e],
      [Math.max(0, qa.s - 1), Math.max(0, qa.e - 1)],
    ];
    let best = null;
    for (const forecastEnd of forecastEnds) {
      for (const plan of planWindows) {
        for (const vision of visionWindows) {
          const stats = dlvCollisions([
            ...base,
            { s: 0, e: forecastEnd },
            { s: plan[0], e: plan[1] },
            { s: vision[0], e: vision[1] },
          ]);
          const score = stats.extraStart * 2 + stats.extraEnd;
          if (!best || score < best.score) best = { score, forecastEnd, plan, vision };
        }
      }
    }
    return best;
  }

  function dlvPlan() {
    const columns = dlvColumns();
    const basis = dlvBasisOf(columns);
    const groups = dlvGroups(basis?.parts || state.system);
    // 轴系那 4 组排在前面，和流程图上"上下两个汇合点"对得上。
    groups.sort((a, b) => {
      const rank = (group) => (group.stage === "asm1" ? 0 : 1);
      return rank(a) - rank(b) || a.index - b.index;
    });
    const maxLead = groups.reduce((max, group) => Math.max(max, group.lead), 0);
    const groupByCode = new Map(groups.map((group) => [group.code, group]));

    /* 调平（资源均衡）：人只有一双手，所以采购条只占"下单那一天"，供应商交期另画成浅色轨道。
       下单日的铺法：先按"全部第 0 天下单"排一遍拿到基准总时长，从总时长倒推每道工序最晚开工，
       再折成每组"最晚下单日"，按最晚下单日从紧到松铺、一天最多两单 —— 总时长不变，但同一个人不再 7 条并行。 */
    const plain = dlvStageTimes(groupByCode, (code) => groupByCode.get(code)?.lead ?? 0);
    const plainNeed = plain.reduce((max, stage) => Math.max(max, stage.e), 0) + 1;
    const plainQa = plain.find((stage) => stage.id === "qa");
    const plainAsm2 = plain.find((stage) => stage.id === "asm2");
    const plainAsm1 = plain.find((stage) => stage.id === "asm1");
    const qaStartLimit = plainNeed - plainQa.days;
    const asm2StartLimit = qaStartLimit - 1 - plainAsm2.days + 1;
    const asm1StartLimit = asm2StartLimit - 1 - plainAsm1.days + 1;
    const deadlineOf = (code) =>
      groupByCode.get(code)?.stage === "asm1" ? asm1StartLimit : asm2StartLimit;

    let leveled = dlvLevelOrders(groups, deadlineOf);
    let stages = dlvStageTimes(groupByCode, (code) => leveled.get(code)?.arrive ?? 0);
    let need = stages.reduce((max, stage) => Math.max(max, stage.e), 0) + 1;
    if (need > plainNeed) {
      // 兜底：调平反而把总时长顶长了，就退回"全部第 0 天上午下单"。
      leveled = new Map(
        groups.map((group) => [
          group.code,
          { slot: 0, start: 0, end: 0.5, arrive: group.lead, latest: 0 },
        ]),
      );
      stages = plain;
      need = plainNeed;
    }
    const lastArrival = groups.reduce(
      (max, group) => Math.max(max, leveled.get(group.code).arrive),
      0,
    );

    const tasks = groups.map((group) => {
      const slot = leveled.get(group.code);
      return {
        id: `buy-${group.code}`,
        kind: "buy",
        lane: "buy",
        groupCode: group.code,
        stage: group.stage,
        name: `${group.name} · 采购下单`,
        short: group.name,
        s: slot.start,
        e: Math.floor(slot.start),
        end: slot.end,
        arrive: slot.arrive,
        lead: group.lead,
        days: 0.5,
        high: group.high,
        detail: `下单半天（周予），供应商交期 ${group.lead} 天，第 ${slot.arrive + 1} 天到料`,
      };
    });

    for (const stage of stages) {
      const codes = stage.codes;
      const lane = DLV_LANE_BY_ID.get(stage.lane);
      tasks.push({
        id: stage.id,
        kind: stage.id === "qa" ? "qa" : "asm",
        lane: stage.lane,
        name: stage.name,
        short: stage.short,
        s: stage.s,
        e: stage.e,
        days: stage.days,
        gate: stage.gate,
        detail:
          stage.id === "qa"
            ? "总装下线后做整机点检、老化与验收"
            : codes.length
              ? `等 ${codes.length} 组齐套（第 ${stage.ready + 1} 天）后开工`
              : "串行在上一道之后",
        dependsOn: [...codes.map((code) => `buy-${code}`), ...(stage.id === "asm2" ? ["asm1"] : [])],
      });
    }
    const asm1 = stages.find((stage) => stage.id === "asm1") || { s: 0 };
    const qa = stages.find((stage) => stage.id === "qa") || { s: 0, e: 0, days: 1 };

    // AI 三条任务的落点也让开：在不改变含义的前提下，挑一组"同时开工/收尾最少"的窗口。
    const aiWindows = dlvPickAiWindows({ base: tasks, asm1, qa, lastArrival, limit: need - 1 });
    tasks.push(
      {
        id: "ai-forecast",
        kind: "ai",
        lane: "ai",
        name: "到料风险预测与齐套预警",
        short: "到料预测",
        s: 0,
        e: aiWindows.forecastEnd,
        days: aiWindows.forecastEnd + 1,
        detail: `滚动预测 ${groups.length} 组到料与瓶颈，输出齐套日期`,
      },
      {
        id: "ai-plan",
        kind: "ai",
        lane: "ai",
        name: "装配序列与工位排程",
        short: "装配排程",
        s: aiWindows.plan[0],
        e: aiWindows.plan[1],
        days: aiWindows.plan[1] - aiWindows.plan[0] + 1,
        detail: `轴系开工前把工位、夹具和节拍排出来`,
      },
      {
        id: "ai-vision",
        kind: "ai",
        lane: "ai",
        name: "视觉检测与验收报告",
        short: "视觉检测",
        s: aiWindows.vision[0],
        e: aiWindows.vision[1],
        days: aiWindows.vision[1] - aiWindows.vision[0] + 1,
        detail: "装配缺陷视觉筛查 + 验收报告初稿",
      },
    );

    tasks.sort((a, b) => {
      const order = (task) => DLV_LANES.findIndex((lane) => lane.id === task.lane);
      return order(a) - order(b) || a.s - b.s;
    });

    const start = state.delivery.start || dlvDefaultStart();
    let end = state.delivery.end;
    if (!end || dlvDiff(start, end) < 0) end = dlvShift(start, need - 1);
    const days = Math.max(1, dlvDiff(start, end) + 1);
    const window = {
      start,
      end,
      days,
      need,
      slack: days - need,
      over: tasks.filter((task) => dlvEndOf(task) > days + 1e-9).length,
    };

    const highRisk = groups.reduce((sum, group) => sum + group.high, 0);
    const highRiskGroups = groups.filter((group) => group.high > 0);
    const lastHigh = highRiskGroups.length
      ? highRiskGroups.reduce((max, group) => Math.max(max, leveled.get(group.code).arrive), 0)
      : 0;

    const alerts = [
      {
        level: "info",
        day: Math.max(0, lastArrival),
        label: `齐套 · ${groups.length} 组到料`,
      },
      { level: "warn", day: stages.find((stage) => stage.id === "asm2")?.s ?? 0, label: "总装开工" },
    ];
    if (highRisk > 0) {
      alerts.push({
        level: "warn",
        day: Math.max(0, lastHigh),
        label: `高风险 ${highRisk} 项到齐`,
      });
    }
    if (window.slack < 0) {
      alerts.push({
        level: "risk",
        day: Math.max(0, days - 1),
        label: `窗口不足 · 超出 ${-window.slack} 天`,
      });
    } else if (window.slack === 0) {
      alerts.push({ level: "risk", day: Math.max(0, days - 1), label: "窗口用满 · 余量 0" });
    } else {
      alerts.push({ level: "info", day: Math.max(0, need - 1), label: `计划完成 · 余量 ${window.slack} 天` });
    }
    alerts.sort((a, b) => a.day - b.day || a.level.localeCompare(b.level));

    // 同一天的多条并成一面旗子：旗子都挤在窗口右端，不合并会互相压住。
    const mergedAlerts = [];
    for (const alert of alerts) {
      const last = mergedAlerts[mergedAlerts.length - 1];
      if (last && last.day === alert.day) {
        const rank = { info: 0, warn: 1, risk: 2 };
        if (rank[alert.level] > rank[last.level]) last.level = alert.level;
        last.label = `${last.label}；${alert.label}`;
      } else {
        mergedAlerts.push({ ...alert });
      }
    }

    const flowLayout = dlvFlowLayout(tasks);
    const collisions = dlvCollisions(tasks);
    const personOverlap = dlvPersonOverlap(tasks);

    return {
      basis: basis
        ? { id: basis.id, name: basis.name, score: basis.final.score, system: basis.system }
        : { id: "system", name: "系统推荐", score: 0, system: true },
      columns: columns.map((column) => ({
        id: column.id,
        name: column.name,
        score: column.final.score,
      })),
      groups,
      stages,
      tasks,
      alerts: mergedAlerts,
      flowLayout,
      window,
      collisions,
      personOverlap,
      lastArrival,
      stats: {
        groups: groups.length,
        maxLead,
        need,
        highRisk,
        lastHigh,
        lastArrival,
        personOverlap,
        maxStart: collisions.maxStart,
        maxEnd: collisions.maxEnd,
        aiTasks: tasks.filter((task) => task.lane === "ai").length,
        nonAiTasks: tasks.filter((task) => task.lane !== "ai").length,
        people: DLV_LANES.length - 1,
      },
    };
  }

  /* ---------------- 流程图几何：固定 4 列，AI 单独一条带 ---------------- */

  const DLV_FLOW_GEOM = {
    cardW: 158,
    buyH: 38,
    buyGap: 46,
    stageH: 62,
    aiH: 56,
    col: { buy: 0, mid: 200, asm: 380, qa: 560 },
    buyTop: 42,
    asm1Top: 99,
    asm2Top: 230,
    aiTop: 420,
    width: 726,
    height: 484,
  };

  function dlvFlowLayout(tasks) {
    const geom = DLV_FLOW_GEOM;
    const layout = new Map();
    const buys = tasks.filter((task) => task.kind === "buy");
    buys.forEach((task, index) => {
      layout.set(task.id, {
        x: geom.col.buy,
        y: geom.buyTop + index * geom.buyGap,
        w: geom.cardW,
        h: geom.buyH,
      });
    });
    layout.set("asm1", { x: geom.col.asm, y: geom.asm1Top, w: geom.cardW, h: geom.stageH });
    layout.set("asm2", { x: geom.col.asm, y: geom.asm2Top, w: geom.cardW, h: geom.stageH });
    layout.set("qa", { x: geom.col.qa, y: geom.asm2Top, w: geom.cardW, h: geom.stageH });
    layout.set("ai-forecast", { x: geom.col.buy, y: geom.aiTop, w: geom.cardW, h: geom.aiH });
    layout.set("ai-plan", { x: geom.col.mid, y: geom.aiTop, w: geom.cardW, h: geom.aiH });
    layout.set("ai-vision", { x: geom.col.qa, y: geom.aiTop, w: geom.cardW, h: geom.aiH });
    return layout;
  }

  function dlvTaskById(tasks, id) {
    return tasks.find((task) => task.id === id) || null;
  }

  function dlvTaskDates(plan, task) {
    const startDay = Math.floor(task.s);
    const endDay = Math.max(startDay, Math.ceil(dlvEndOf(task)) - 1);
    return {
      start: dlvShift(plan.window.start, startDay),
      end: dlvShift(plan.window.start, endDay),
    };
  }

  function dlvTaskRange(plan, task) {
    if (task.kind === "buy") {
      const order = dlvShift(plan.window.start, Math.floor(task.s));
      const arrive = dlvShift(plan.window.start, task.arrive);
      return `${dlvMonthDay(order)} 下单 → ${dlvMonthDay(arrive)} 到料`;
    }
    const { start, end } = dlvTaskDates(plan, task);
    const sameDay = task.s === task.e;
    return sameDay
      ? `${dlvMonthDay(start)}`
      : `${dlvMonthDay(start)} – ${dlvMonthDay(end)}`;
  }

  /* ---------------- 渲染：交付排期 ---------------- */

  function renderDelivery() {
    const host = $("#view-delivery");
    if (!host || host.hidden) return;
    const plan = dlvPlan();
    if (!state.delivery.start) state.delivery.start = plan.window.start;
    if (!state.delivery.end) state.delivery.end = plan.window.end;

    state.lastDelivery = plan;
    renderDeliveryHead(plan);
    renderDeliveryToolbar(plan);
    renderDeliveryGantt(plan);
    renderDeliveryLegend(plan);
    renderDeliveryFlow(plan);
    renderDeliveryCards(plan);
    saveState();
  }

  function renderDeliveryHead(plan) {
    const metrics = $("#dlvMetrics");
    if (!metrics) return;
    const lastArrival = plan.stats.maxLead;
    const asm2Stage = plan.stages.find((stage) => stage.id === "asm2");
    const qaStage = plan.stages.find((stage) => stage.id === "qa");
    const items = [
      {
        label: "计划周期",
        value: `${plan.window.need} 天`,
        note: `${plan.window.days} 天窗口 · 余量 ${plan.window.slack > 0 ? "+" : ""}${plan.window.slack} 天`,
        tone: plan.window.slack < 0 ? "risk" : plan.window.slack === 0 ? "warn" : "ok",
      },
      {
        label: "首批到料",
        value: `第 ${lastArrival} 天`,
        note: `${dlvWeekdayLabel(dlvShift(plan.window.start, lastArrival - 1))} · ${dlvMonthDay(
          dlvShift(plan.window.start, lastArrival - 1),
        )}`,
        tone: "ok",
      },
      {
        label: "关键路径",
        value: `${plan.stats.maxLead}+${asm2Stage?.days ?? 3}+${qaStage?.days ?? 2}`,
        note: `采购 → 总装 → 检查 = ${plan.stats.need} 天`,
        tone: "ok",
      },
      {
        label: "高风险件",
        value: `${plan.stats.highRisk} 项`,
        note: plan.stats.highRisk ? `最晚第 ${plan.stats.lastHigh} 天到料` : "无",
        tone: plan.stats.highRisk > 0 ? "warn" : "ok",
      },
      {
        label: "任务 / 人",
        value: `${plan.tasks.length} 项`,
        note: `AI ${plan.stats.aiTasks} · 采购 ${
          plan.tasks.filter((task) => task.lane === "buy").length
        } · 装配 2 · 检查 1`,
        tone: "ok",
      },
    ];
    metrics.replaceChildren(
      ...items.map((item) =>
        h(
          "div",
          { class: `dlv-metric is-${item.tone}` },
          h("span", { class: "dlv-metric-label", text: item.label }),
          h("strong", { text: item.value }),
          h("small", { text: item.note }),
        ),
      ),
    );

    const lead = $("#dlvLead");
    if (lead) {
      lead.textContent = `按「${plan.basis.name}」（${
        plan.basis.score ? `${plan.basis.score.toFixed(1)} 分` : "当前方案"
      }）里 ${state.partTypes.size} 个零件的交期倒排：7 组采购（半天一单，同一人零重叠）→ 轴系组装 → 电气总装 → 整机检查，AI 三条任务并行，总时长不变。`;
    }
  }

  function renderDeliveryToolbar(plan) {
    const start = $("#dlvStart");
    const end = $("#dlvEnd");
    const days = $("#dlvDays");
    const basis = $("#dlvBasis");
    if (!start || !end) return;
    start.value = plan.window.start;
    end.value = plan.window.end;
    if (days) {
      days.textContent = `${plan.window.days} 天 · ${dlvMonthDay(plan.window.start)}–${dlvMonthDay(
        plan.window.end,
      )}`;
    }
    if (basis) {
      basis.replaceChildren(
        ...plan.columns.map((column) =>
          h("option", {
            value: column.id,
            text: `${column.name} · ${column.score.toFixed(1)} 分`,
            selected: column.id === plan.basis.id,
          }),
        ),
      );
    }

    const note = $("#dlvNote");
    if (!note) return;
    const messages = [];
    if (plan.window.slack < 0) {
      messages.push(
        `窗口只有 ${plan.window.days} 天，排期需要 ${plan.window.need} 天：${plan.window.over} 项任务被压到窗口外（条形末端红色斜纹）。点「按交期自动排」可把窗口拉到 ${plan.window.need} 天。`,
      );
    } else if (plan.window.slack === 0) {
      messages.push(`窗口正好用满：${plan.window.need} 天，没有任何缓冲，任一零件晚到都会顶到交付日。`);
    } else {
      messages.push(`窗口 ${plan.window.days} 天，排期占 ${plan.window.need} 天，尾部留 ${plan.window.slack} 天缓冲。`);
    }
    if (plan.stats.highRisk > 0) {
      messages.push(
        `高风险件 ${plan.stats.highRisk} 项，最晚第 ${plan.stats.lastHigh} 天到料 —— 这条决定整机检查能不能按期开始。`,
      );
    }
    note.hidden = messages.length === 0;
    note.replaceChildren(...messages.map((text) => h("span", { text })));
    note.classList.toggle("is-risk", plan.window.slack < 0);
  }

  function renderDeliveryGantt(plan) {
    const plot = $("#dlvPlot");
    const labels = $("#dlvLabels");
    const axis = $("#dlvAxis");
    const months = $("#dlvMonths");
    const alerts = $("#dlvAlertPlot");
    const grid = $("#dlvGrid");
    if (!plot || !labels) return;

    const days = plan.window.days;
    const hidden = new Set(state.delivery.hidden || []);
    const rowHeight = 26;
    const laneHeight = 22;
    const gap = 5;

    plot.style.setProperty("--days", String(days));
    const ganttHost = $("#dlvGantt");
    if (ganttHost) ganttHost.style.setProperty("--days", String(days));
    labels.replaceChildren();
    plot.replaceChildren();
    if (alerts) alerts.replaceChildren();

    // 周末底纹 + 预警竖线放在最底层
    if (grid) {
      grid.replaceChildren();
      for (let day = 0; day < days; day += 1) {
        const weekday = dlvParse(dlvShift(plan.window.start, day)).getDay();
        if (weekday !== 0 && weekday !== 6) continue;
        grid.append(
          h("i", {
            class: "dlv-weekend",
            style: `left:${(day / days) * 100}%;width:${100 / days}%`,
          }),
        );
      }
    }

    const rows = [];
    for (const lane of DLV_LANES) {
      const laneTasks = plan.tasks.filter(
        (task) => task.lane === lane.id && !hidden.has(task.lane),
      );
      rows.push({ lane, tasks: laneTasks });
    }

    let cursor = 0;
    const tops = new Map();
    let visible = 0;

    for (const row of rows) {
      if (row.tasks.length === 0) continue;
      const laneRow = h(
        "div",
        { class: "dlv-lane-head", style: `top:${cursor}px;height:${laneHeight}px` },
        h("i", { style: `background:${row.lane.color}` }),
        h("span", {
          text: row.lane.owner === "AI" ? row.lane.name : `${row.lane.name} · ${row.lane.owner}`,
        }),
        h("small", { text: `${row.tasks.length} 项` }),
      );
      labels.append(laneRow);
      cursor += laneHeight + 2;

      for (const task of row.tasks) {
        tops.set(task.id, cursor);
        const meta =
          task.kind === "buy" ? `${task.lead} 天` : `D${Math.floor(task.s) + 1}–D${Math.ceil(dlvEndOf(task))}`;
        labels.append(
          h(
            "div",
            { class: "dlv-row-label", style: `top:${cursor}px;height:${rowHeight}px` },
            h("i", { style: `background:${row.lane.color}` }),
            h("span", { class: "dlv-row-name", text: task.short }),
            h("small", { text: meta }),
          ),
        );
        cursor += rowHeight + gap;
        visible += 1;
      }
    }

    const total = Math.max(120, cursor);
    plot.style.height = `${total}px`;
    labels.style.height = `${total}px`;

    const plotWidth = plot.clientWidth || 900;
    for (const task of plan.tasks) {
      if (!tops.has(task.id)) continue;
      const lane = DLV_LANE_BY_ID.get(task.lane);
      const top = tops.get(task.id);
      const endAt = dlvEndOf(task);
      // 超窗的任务不丢：压成半天宽的小块贴到窗口右端，标红提示。
      const start = Math.min(task.s, days - 0.5);
      const end = Math.min(Math.max(endAt, start + 0.5), days);
      if (end <= start) continue;
      const over = endAt > days + 1e-9;

      // 采购：实心块 = 下单那半天（占人），虚线轨道 = 供应商交期（不占人），菱形 = 到料日。
      if (task.kind === "buy") {
        const arrive = Math.min(task.arrive, days - 1);
        const arriveRatio = (arrive + 0.5) / days;
        plot.append(
          h("i", {
            class: "dlv-track",
            style: `left:${((start + 0.5) / days) * 100}%;width:${Math.max(
              0.4,
              (arrive - start) / days * 100,
            )}%;top:${top + rowHeight / 2}px;--bar:${lane.color}`,
          }),
        );
        plot.append(
          h("i", {
            class: "dlv-arrive",
            style: `left:${arriveRatio * 100}%;top:${top + rowHeight / 2 - 4}px;--bar:${lane.color}`,
          }),
        );
        plot.append(
          h("span", {
            class: "dlv-row-note",
            style: `left:${arriveRatio * 100}%;top:${top + 15}px;transform:translateX(${
              arriveRatio > 0.84 ? "-108%" : "10px"
            })`,
            text: `${dlvMonthDay(dlvShift(plan.window.start, arrive))} 到料`,
          }),
        );
      }

      const bar = h("div", {
        class: `dlv-bar${over ? " is-over" : ""}${
          task.kind === "ai" ? " is-ai" : ""
        }${task.kind === "buy" ? " is-buy" : ""}`,
        style: `left:${(start / days) * 100}%;width:${((end - start) / days) * 100}%;top:${
          top + 4
        }px;height:${rowHeight - 8}px;--bar:${lane.color}`,
        dataset: { dlvBar: task.id },
      });
      const spanDays = end - start;
      // 条形窄到放不下字就不写，宁可留白也别把文字挤到条外。
      if ((spanDays / days) * plotWidth >= 56) {
        bar.append(h("span", { class: "dlv-bar-label", text: task.short }));
      }
      if (over) bar.append(h("span", { class: "dlv-bar-over", text: "超窗" }));
      bar.addEventListener("mouseenter", () => showDeliveryTip(bar, plan, task));
      bar.addEventListener("mouseleave", () => hideTooltip());
      bar.addEventListener("click", () => flashFlowNode(task.id));
      plot.append(bar);
    }

    // 预警线：竖线贯穿绘图区，旗子在上面的窄条里
    const flagEls = [];
    for (const alert of plan.alerts) {
      const ratio = (Math.min(alert.day, days - 1) + 0.5) / days;
      const level = DLV_ALERT_LEVELS[alert.level] || DLV_ALERT_LEVELS.info;
      plot.append(
        h("i", {
          class: "dlv-alert-line",
          style: `left:${ratio * 100}%;border-color:${level.color}`,
        }),
      );
      if (!alerts) continue;
      const flag = h(
        "div",
        {
          class: "dlv-flag",
          style: `border-color:${level.color};color:${level.color}`,
          title: `${level.label} · 第 ${alert.day + 1} 天（${dlvMonthDay(
            dlvShift(plan.window.start, alert.day),
          )}）`,
        },
        h("i", { style: `background:${level.color}` }),
        h("span", { text: alert.label }),
      );
      alerts.append(flag);
      flagEls.push({ flag, ratio });
    }

    // 旗子按像素排：先对准当天，再左右夹紧，撞上了就换行 —— 免得互相压住或被面板裁掉。
    if (flagEls.length) {
      const width = alerts.clientWidth || plot.clientWidth || 1;
      const rowRight = [-Infinity, -Infinity, -Infinity];
      for (const item of flagEls) {
        const flagWidth = item.flag.offsetWidth;
        const left = Math.min(
          Math.max(item.ratio * width - flagWidth / 2, 0),
          Math.max(0, width - flagWidth),
        );
        let row = rowRight.findIndex((right) => left >= right + 6);
        if (row === -1) row = rowRight.indexOf(Math.min(...rowRight));
        rowRight[row] = left + flagWidth;
        item.flag.style.left = `${Math.round(left)}px`;
        item.flag.style.top = `${2 + row * 22}px`;
      }
    }

    if (axis) renderDeliveryAxis(axis, months, plan);
    state.deliveryVisible = visible;
  }

  function renderDeliveryAxis(axis, monthHost, plan) {
    const days = plan.window.days;
    axis.replaceChildren();
    const step = Math.max(1, Math.ceil(days / 7));
    const marks = [];
    for (let day = 0; day < days; day += step) marks.push(day);
    if (marks[marks.length - 1] !== days - 1) marks.push(days - 1);
    for (const day of marks) {
      axis.append(
        h("span", {
          class: "dlv-tick",
          style: `left:${((day + 0.5) / days) * 100}%`,
          text: dlvMonthDay(dlvShift(plan.window.start, day)),
        }),
      );
    }

    if (!monthHost) return;
    monthHost.replaceChildren();
    let offset = 0;
    while (offset < days) {
      const date = dlvParse(dlvShift(plan.window.start, offset));
      const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);
      const stop = Math.min(days - 1, dlvDiff(plan.window.start, dlvIso(monthEnd)));
      const span = stop - offset + 1;
      monthHost.append(
        h("span", {
          class: "dlv-month",
          style: `left:${(offset / days) * 100}%;width:${(span / days) * 100}%`,
          text: `${date.getMonth() + 1} 月`,
        }),
      );
      offset = stop + 1;
    }
  }

  function renderDeliveryLegend(plan) {
    const host = $("#dlvLegend");
    if (!host) return;
    const hidden = new Set(state.delivery.hidden || []);
    host.replaceChildren();
    host.append(h("span", { class: "dlv-legend-title", text: "人员 / 角色" }));
    for (const lane of DLV_LANES) {
      const count = plan.tasks.filter((task) => task.lane === lane.id).length;
      host.append(
        h(
          "button",
          {
            type: "button",
            class: `dlv-legend-item${hidden.has(lane.id) ? " is-off" : ""}`,
            style: `--bar:${lane.color}`,
            dataset: { dlvLane: lane.id },
            title: `点击${hidden.has(lane.id) ? "显示" : "隐藏"} ${lane.owner} 的任务`,
          },
          h("i", { style: `background:${lane.color}` }),
          h("span", {
            text: lane.owner === "AI" ? lane.name : `${lane.name} · ${lane.owner}`,
          }),
          h("small", { text: `${count} 项` }),
        ),
      );
    }
    host.append(h("span", { class: "dlv-legend-title", text: "预警线" }));
    for (const [level, meta] of Object.entries(DLV_ALERT_LEVELS)) {
      host.append(
        h(
          "span",
          { class: "dlv-legend-note" },
          h("i", { style: `background:${meta.color}` }),
          h("span", { text: meta.label }),
        ),
      );
    }
    host.append(
      h("span", {
        class: "dlv-legend-hint",
        text: "实心块 = 人员占用；虚线轨道 + 菱形 = 供应商交期与到料日（不占人）。",
      }),
    );
  }

  function renderDeliveryCards(plan) {
    const host = $("#dlvCards");
    if (!host) return;
    host.replaceChildren();

    /* 周期风险 */
    const riskCard = h(
      "article",
      { class: `dlv-card${plan.window.slack < 0 ? " is-risk" : ""}` },
      h(
        "header",
        {},
        h("strong", { text: "周期风险" }),
        h("span", { text: "由交期与窗口推出来的节点与预警" }),
      ),
    );
    const riskList = h("ul", { class: "dlv-risk-list" });
    for (const alert of plan.alerts) {
      const level = DLV_ALERT_LEVELS[alert.level] || DLV_ALERT_LEVELS.info;
      riskList.append(
        h(
          "li",
          {},
          h("i", { style: `background:${level.color}` }),
          h("b", { text: `D${alert.day + 1}` }),
          h("span", { text: alert.label }),
          h("small", { text: dlvMonthDay(dlvShift(plan.window.start, alert.day)) }),
        ),
      );
    }
    riskCard.append(riskList);
    riskCard.append(
      h("p", {
        text:
          plan.window.slack < 0
            ? `计划比窗口长 ${-plan.window.slack} 天：要么把窗口拉长，要么压缩轴系/总装的工期，要么换交期更短的低风险件。`
            : plan.stats.highRisk > 0
              ? `窗口够用，但 ${plan.stats.highRisk} 项高风险件卡在第 ${plan.stats.lastHigh} 天到料，是最大的单点。`
              : "窗口与交期都还有余量，按当前方案可以直接下发。",
      }),
    );

    /* 人员负载 */
    const loadCard = h(
      "article",
      { class: "dlv-card" },
      h(
        "header",
        {},
        h("strong", { text: "人员协作" }),
        h("span", {
          text: `${plan.stats.people} 人 + AI，${plan.tasks.length} 项任务`,
        }),
      ),
    );
    const loadList = h("ul", { class: "dlv-load-list" });
    for (const lane of DLV_LANES) {
      const laneTasks = plan.tasks.filter((task) => task.lane === lane.id);
      if (laneTasks.length === 0) continue;
      const first = Math.min(...laneTasks.map((task) => task.s));
      const last = Math.max(...laneTasks.map((task) => Math.ceil(dlvEndOf(task)) - 1));
      const span = last - first + 1;
      loadList.append(
        h(
          "li",
          {},
          h("i", { style: `background:${lane.color}` }),
          h("b", { text: lane.owner }),
          h("span", { text: `${lane.name} · ${laneTasks.length} 项` }),
          h("small", { text: `D${first + 1}–D${last + 1} · ${span} 天` }),
          h("em", {
            style: `width:${Math.round((span / plan.window.days) * 100)}%;background:${lane.color}`,
          }),
        ),
      );
    }
    loadCard.append(loadList);
    const buyTasks = plan.tasks.filter((task) => task.lane === "buy");
    const buyFirst = Math.min(...buyTasks.map((task) => task.s));
    const buyLast = Math.max(...buyTasks.map((task) => dlvEndOf(task)));
    loadCard.append(
      h("p", {
        text: `周予的 ${buyTasks.length} 张采购单按半天一单排开（D${Math.floor(buyFirst) + 1}–D${Math.ceil(
          buyLast,
        )}），同一时刻只有一单在手上；陈屿两道组装首尾相接、不重叠；苏航只在最后两天进场；AI 三条任务由不同模型服务执行，允许并行。`,
      }),
    );
    loadCard.append(
      h("div", {
        class: "dlv-card-stat",
        text: `同一人重叠 ${plan.personOverlap} 天 · 同日开工最多 ${plan.collisions.maxStart} 项 · 同日收尾最多 ${plan.collisions.maxEnd} 项`,
      }),
    );

    /* 排期口径 */
    const ruleCard = h(
      "article",
      { class: "dlv-card" },
      h("header", {}, h("strong", { text: "排期口径" }), h("span", { text: "怎么算出来的" })),
    );
    const rules = [
      `采购：7 组按"最晚下单日"从紧到松下单，半天一单（一天最多两单）；下单当时起算供应商交期，最长 ${plan.stats.maxLead} 天。`,
      `轴系组装：等俯仰 / 横滚 / 航向 / 手柄 4 组齐套后开工，${plan.stages[0]?.days ?? 3} 天。`,
      `电气总装：等轴系组装完成、且相机 / 控制 / 电源 3 组到料，${plan.stages[1]?.days ?? 3} 天。`,
      `整机检查：总装下线后开工，${plan.stages[2]?.days ?? 2} 天；总时长与"全部第 0 天下单"一致。`,
    ];
    ruleCard.append(h("ul", { class: "dlv-rule-list" }, ...rules.map((text) => h("li", { text }))));

    host.append(riskCard, loadCard, ruleCard);
  }

  /* ---------------- 渲染：配套流程图 ---------------- */

  function renderDeliveryFlow(plan) {
    const canvas = $("#dlvFlow");
    const svg = $("#dlvFlowSvg");
    if (!canvas || !svg) return;
    for (const node of [...canvas.querySelectorAll(".dlv-node, .dlv-stage-label, .dlv-map-hint")]) {
      node.remove();
    }
    svg.replaceChildren();
    const geom = DLV_FLOW_GEOM;
    canvas.style.width = `${geom.width}px`;
    canvas.style.height = `${geom.height}px`;
    svg.setAttribute("width", String(geom.width));
    svg.setAttribute("height", String(geom.height));

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
      <marker id="dlvArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0L10 5L0 10z" fill="#74869a"/>
      </marker>`;
    svg.append(defs);

    // 阶段标注
    const buyTasks = plan.tasks.filter((task) => task.kind === "buy");
    const orderDayCount = new Set(buyTasks.map((task) => Math.floor(task.s))).size;
    const labels = [
      { x: 0, text: `① 采购 ${buyTasks.length} 单 · 半天一单，占 ${orderDayCount} 天` },
      { x: geom.col.asm, text: "② 轴系组装 → ③ 电气总装" },
      { x: geom.col.qa, text: "④ 整机检查" },
    ];
    for (const item of labels) {
      canvas.append(
        h("div", {
          class: "dlv-stage-label",
          style: `left:${item.x}px;top:10px`,
          text: item.text,
        }),
      );
    }

    const posOf = (id) => {
      const box = plan.flowLayout.get(id);
      return box ? { ...box, cx: box.x + box.w / 2, cy: box.y + box.h / 2 } : null;
    };

    const line = (d, { dashed = false, color = "#74869a" } = {}) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-opacity", dashed ? "0.45" : "0.6");
      path.setAttribute("stroke-width", "1.5");
      if (dashed) path.setAttribute("stroke-dasharray", "5 5");
      path.setAttribute("marker-end", "url(#dlvArrow)");
      svg.append(path);
    };

    // 采购 → 两道装配：先汇合再进装配，避免 7 根箭头糊成一团
    const buys = plan.tasks.filter((task) => task.kind === "buy");
    const groupsOfFlow = [
      { stage: "asm1", target: "asm1" },
      { stage: "asm2", target: "asm2" },
    ];
    for (const spec of groupsOfFlow) {
      const members = buys.filter((task) => task.stage === spec.stage);
      if (members.length === 0) continue;
      const boxes = members.map((task) => posOf(task.id)).filter(Boolean);
      const busX = geom.cardW + 14;
      const top = Math.min(...boxes.map((box) => box.cy));
      const bottom = Math.max(...boxes.map((box) => box.cy));
      const target = posOf(spec.target);
      line(`M${busX},${top}V${bottom}`, { color: "#4d6b8a" });
      for (const box of boxes) line(`M${geom.cardW},${box.cy}H${busX}`, { color: "#4d6b8a" });
      line(`M${busX},${target.cy}H${target.x - 2}`, { color: "#4d6b8a" });
    }

    const asm1 = posOf("asm1");
    const asm2 = posOf("asm2");
    const qa = posOf("qa");
    if (asm1 && asm2) line(`M${asm1.cx},${asm1.y + asm1.h}V${asm2.y - 2}`);
    if (asm2 && qa) line(`M${asm2.x + asm2.w},${asm2.cy}H${qa.x - 2}`);

    // AI 三条虚线：预测贯穿采购、排程进装配、检测陪检查
    const forecast = posOf("ai-forecast");
    const plan2 = posOf("ai-plan");
    const vision = posOf("ai-vision");
    if (forecast) {
      const lastBuy = posOf(buys[buys.length - 1]?.id);
      if (lastBuy) line(`M${forecast.cx},${forecast.y}V${lastBuy.y + lastBuy.h + 2}`, { dashed: true });
    }
    if (plan2 && asm1) {
      line(
        `M${plan2.x + plan2.w},${plan2.cy}C${plan2.x + plan2.w + 40},${plan2.cy} ${
          asm1.x - 40
        },${asm1.y + asm1.h} ${asm1.x - 2},${asm1.y + asm1.h - 4}`,
        { dashed: true },
      );
    }
    if (vision && qa) line(`M${vision.cx},${vision.y}V${qa.y + qa.h + 2}`, { dashed: true });

    // 节点
    const hidden = new Set(state.delivery.hidden || []);
    for (const task of plan.tasks) {
      const box = plan.flowLayout.get(task.id);
      if (!box) continue;
      const lane = DLV_LANE_BY_ID.get(task.lane);
      const node = h("div", {
        class: `dlv-node is-${task.kind}${hidden.has(task.lane) ? " is-off" : ""}`,
        style: `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;--bar:${lane.color}`,
        dataset: { dlvNode: task.id },
      });
      node.append(
        h("i", { class: "dlv-node-rail", style: `background:${lane.color}` }),
        h(
          "div",
          { class: "dlv-node-body" },
          h(
            "div",
            { class: "dlv-node-top" },
            h("span", {
              class: "dlv-node-owner",
              text: lane.owner === "AI" ? lane.name : `${lane.owner} · ${lane.name}`,
            }),
            h("small", { text: `D${Math.floor(task.s) + 1}–D${Math.ceil(dlvEndOf(task))}` }),
          ),
          h("strong", { text: task.name }),
          h("div", { class: "dlv-node-foot" }, h("span", { text: dlvTaskRange(plan, task) })),
        ),
      );
      if (task.high > 0) {
        node.append(h("b", { class: "dlv-node-warn", text: `⚠ ${task.high}` }));
      }
      node.addEventListener("click", () => flashBar(task.id));
      node.addEventListener("mouseenter", () => showDeliveryTip(node, plan, task));
      node.addEventListener("mouseleave", () => hideTooltip());
      canvas.append(node);
    }

    const hint = h("div", {
      class: "dlv-map-hint",
      style: `left:0;top:${geom.aiTop - 24}px`,
      text: "AI 赋能带（虚线 = 建议 / 预测，不是硬依赖）",
    });
    canvas.append(hint);
  }

  function flashBar(id) {
    const bar = document.querySelector(`[data-dlv-bar="${id}"]`);
    if (!bar) return;
    bar.classList.add("is-flash");
    bar.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    setTimeout(() => bar.classList.remove("is-flash"), 1400);
  }

  function flashFlowNode(id) {
    const node = document.querySelector(`[data-dlv-node="${id}"]`);
    if (!node) return;
    node.classList.add("is-flash");
    node.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    setTimeout(() => node.classList.remove("is-flash"), 1400);
  }

  function showDeliveryTip(target, plan, task) {
    const lane = DLV_LANE_BY_ID.get(task.lane);
    const dates = dlvTaskDates(plan, task);
    const list = h("dl");
    list.append(
      h("dt", { text: "责任人" }),
      h("dd", { text: `${lane.owner}（${lane.name}）` }),
    );
    if (task.kind === "buy") {
      const arrive = dlvShift(plan.window.start, task.arrive);
      list.append(
        h("dt", { text: "下单" }),
        h("dd", { text: `${dates.start} · 1 天（占人）` }),
        h("dt", { text: "到料" }),
        h("dd", { text: `${arrive} · 交期 ${task.lead} 天` }),
      );
    } else {
      list.append(
        h("dt", { text: "日期" }),
        h("dd", { text: `${dates.start} → ${dates.end}` }),
        h("dt", { text: "工期" }),
        h("dd", { text: `${task.days} 天` }),
      );
    }
    if (task.detail) {
      list.append(h("dt", { text: "口径" }), h("dd", { text: task.detail }));
    }
    const warn =
      dlvEndOf(task) > plan.window.days + 1e-9
        ? h("div", { class: "s2-tooltip-warn", text: `超出日期窗 ${Math.ceil(dlvEndOf(task) - plan.window.days)} 天` })
        : null;
    tooltip.replaceChildren(h("strong", { text: task.name }), list, warn);
    positionTooltip(target);
  }

  /* ------------------------------------------------------------------ */
  /* 标签页 / 接口占位                                                   */
  /* ------------------------------------------------------------------ */

  // 交付排期已经是实装的一屏；再要加屏，从这里挂 mount 即可。
  window.STAGE2_HOOKS = window.STAGE2_HOOKS || {};
  window.STAGE2_HOOKS.delivery = { status: "ready", mount: renderDelivery };

  function switchTab(id) {
    state.tab = id;
    for (const button of $$(".s2-tab")) {
      const active = button.dataset.tab === id;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
    for (const view of $$(".s2-view")) {
      view.hidden = view.id !== `view-${id}`;
    }
    if (id === "delivery") renderDelivery();
  }

  /* ------------------------------------------------------------------ */
  /* 需求 JSON 弹窗                                                      */
  /* ------------------------------------------------------------------ */

  function openPayload() {
    $("#payloadJson").textContent = JSON.stringify(state.payload, null, 2);
    $("#payloadModal").hidden = false;
    document.body.classList.add("modal-open");
  }

  function closePayload() {
    $("#payloadModal").hidden = true;
    document.body.classList.remove("modal-open");
  }

  /* ------------------------------------------------------------------ */
  /* 错误 / 提示                                                         */
  /* ------------------------------------------------------------------ */

  function showBootError(title, message, retry) {
    $("#bootError").hidden = false;
    $("#bootErrorTitle").textContent = title;
    $("#bootErrorMessage").textContent = message;
    $("#bootRetryBtn").hidden = !retry;
    $("#view-compare").hidden = true;
    $(".s2-tabs").hidden = true;
    $(".s2-footnote").hidden = true;
  }

  /* ------------------------------------------------------------------ */
  /* 悬浮提示                                                            */
  /* ------------------------------------------------------------------ */

  const tooltip = $("#tooltip");
  let tooltipTarget = null;

  function showVariantTip(target, variant) {
    if (!variant) return;
    const list = h("dl");
    if (variant.manufacturer) {
      list.append(h("dt", { text: "厂家" }), h("dd", { text: variant.manufacturer }));
    }
    if (variant.model) {
      list.append(h("dt", { text: "型号" }), h("dd", { text: variant.model }));
    }
    for (const param of variant.coreParams || []) {
      list.append(h("dt", { text: param.label }), h("dd", { text: param.value }));
    }
    list.append(
      h("dt", { text: "性能分" }),
      h("dd", { text: `${(Number(variant.performance) || 0).toFixed(1)} / 100` }),
      h("dt", { text: "单价 / 重量" }),
      h("dd", { text: `${fmtMoney(variant.price)} · ${fmtWeight(variant.weight)}` }),
      h("dt", { text: "交期 / 风险" }),
      h("dd", { text: `${fmtLead(variant.leadTime)} · ${variant.risk}风险` }),
    );
    tooltip.replaceChildren(h("strong", { text: variant.name }), list);
    positionTooltip(target);
  }

  function showTextTip(target, text) {
    tooltip.replaceChildren(h("strong", { text: "硬条件未满足" }), h("div", { text }));
    positionTooltip(target);
  }

  function showConstraintTip(target, index) {
    const constraint = state.heroConstraints[index];
    if (!constraint) return;
    const result = evaluateConstraint(constraint, totalsFor(state.system));
    const list = h("dl");
    list.append(
      h("dt", { text: "条件" }),
      h("dd", { text: displayOf(constraint) }),
    );
    if (result.supported) {
      list.append(
        h("dt", { text: "系统推荐" }),
        h("dd", { text: result.actualText }),
        h("dt", { text: "判定" }),
        h("dd", { text: result.ok ? "达标" : "不达标" }),
      );
    } else {
      list.append(
        h("dt", { text: "系统推荐" }),
        h("dd", { text: "—" }),
        h("dt", { text: "校验" }),
        h("dd", { text: "需人工确认" }),
      );
    }

    const note = result.supported
      ? result.ok
        ? "系统基线满足该条件。"
        : "系统基线未达标，需要在自配方案里调整。"
      : result.reason || "该维度暂不支持自动校验，需人工确认。";
    const noteNode = h("div", {
      class: `s2-tooltip-warn${result.supported && result.ok ? " is-ok" : ""}`,
      text: note,
    });

    tooltip.replaceChildren(
      h("strong", {
        text: `${constraintLabel(constraint)} · ${constraintIsSoft(constraint) ? "软约束" : "硬约束"}`,
      }),
      list,
      noteNode,
    );
    positionTooltip(target);
  }

  function positionTooltip(target) {
    tooltip.hidden = false;
    const rect = target.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - tipRect.height - 8;
    if (top < 8) top = rect.bottom + 8;
    left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, left));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip() {
    tooltip.hidden = true;
    tooltipTarget = null;
  }

  /* ------------------------------------------------------------------ */
  /* 事件                                                                */
  /* ------------------------------------------------------------------ */

  document.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-scheme]");
    if (remove) {
      event.stopPropagation();
      removeScheme(remove.dataset.removeScheme);
      return;
    }

    const toggle = event.target.closest("[data-type-toggle]");
    if (toggle) {
      state.expandedType =
        state.expandedType === toggle.dataset.typeToggle ? null : toggle.dataset.typeToggle;
      renderTree();
      saveState();
      return;
    }

    const add = event.target.closest("[data-add-variant]");
    if (add) {
      if (add.dataset.selected === "1") removeVariant(add.dataset.addType);
      else addVariant(add.dataset.addType, add.dataset.addVariant);
      return;
    }

    const inspect = event.target.closest("[data-inspect-variant]");
    if (inspect) {
      inspectVariant(inspect.dataset.inspectVariant, activeScheme()?.id || "system");
    }
  });

  document.addEventListener("mouseover", (event) => {
    const target = event.target.closest(
      "[data-tip], [data-variant-id], [data-constraint-index]",
    );
    if (!target) return;
    if (target === tooltipTarget) return;
    tooltipTarget = target;
    if (target.dataset.constraintIndex !== undefined) {
      showConstraintTip(target, Number(target.dataset.constraintIndex));
      return;
    }
    if (target.dataset.tip) {
      showTextTip(target, target.dataset.tip);
      return;
    }
    const variant = state.variants.get(target.dataset.variantId);
    if (variant) showVariantTip(target, variant);
  });

  document.addEventListener("mouseout", (event) => {
    const target = event.target.closest(
      "[data-tip], [data-variant-id], [data-constraint-index]",
    );
    if (!target) return;
    if (target.contains(event.relatedTarget)) return;
    hideTooltip();
  });

  document.addEventListener("focusin", (event) => {
    const target = event.target.closest("[data-constraint-index]");
    if (!target) return;
    tooltipTarget = target;
    showConstraintTip(target, Number(target.dataset.constraintIndex));
  });

  document.addEventListener("focusout", (event) => {
    if (event.target.closest("[data-constraint-index]")) hideTooltip();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("#payloadModal").hidden) closePayload();
      hideTooltip();
    }
  });

  window.addEventListener("resize", () => {
    hideTooltip();
    updateMatrixWidth();
  });

  $("#fromSystemBtn").addEventListener("click", () => createScheme("system"));
  $("#fromZeroBtn").addEventListener("click", () => createScheme("zero"));
  $("#compareBtn").addEventListener("click", () => {
    if (!canCompare()) return;
    state.compareMode = true;
    renderAll();
    toast("对比已生成，差异零件已高亮。");
  });
  $("#resetBtn").addEventListener("click", armReset);
  $("#payloadBtn").addEventListener("click", openPayload);
  $("#payloadJson").addEventListener("click", (event) => event.stopPropagation());
  $("#copyPayloadBtn").addEventListener("click", async () => {
    const ok = await copyText(JSON.stringify(state.payload, null, 2));
    toast(ok ? "已复制需求 JSON。" : "复制失败，请手动选择文本。");
  });
  $("#bootRetryBtn").addEventListener("click", () => location.reload());

  for (const closer of $$("[data-close]")) {
    closer.addEventListener("click", closePayload);
  }

  for (const tab of $$(".s2-tab")) {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  }

  /* 交付排期：日期窗、排期基准、一键按交期排、人员图例筛选 */
  $("#dlvStart").addEventListener("change", (event) => {
    const value = event.target.value;
    if (!value) return;
    state.delivery.start = value;
    // 起始日推到终止日之后，窗口就作废，交给新计划重算。
    if (state.delivery.end && state.delivery.end < value) state.delivery.end = "";
    renderDelivery();
  });

  $("#dlvEnd").addEventListener("change", (event) => {
    const value = event.target.value;
    if (!value) return;
    if (value < state.delivery.start) {
      toast("终止日期不能早于起始日期。");
      event.target.value = state.delivery.end || state.delivery.start;
      return;
    }
    state.delivery.end = value;
    renderDelivery();
  });

  $("#dlvAuto").addEventListener("click", () => {
    const plan = dlvPlan();
    state.delivery.start = state.delivery.start || plan.window.start;
    state.delivery.end = dlvShift(state.delivery.start, plan.window.need - 1);
    renderDelivery();
    toast(`已按交期排满 ${plan.window.need} 天，交付日 ${state.delivery.end}。`);
  });

  $("#dlvBasis").addEventListener("change", (event) => {
    state.delivery.basisId = event.target.value;
    // 换基准 = 换一组交期，旧窗口不再成立，让新计划重算。
    state.delivery.end = "";
    renderDelivery();
  });

  $("#view-delivery").addEventListener("click", (event) => {
    const lane = event.target.closest("[data-dlv-lane]");
    if (!lane) return;
    const id = lane.dataset.dlvLane;
    const hidden = new Set(state.delivery.hidden || []);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    state.delivery.hidden = [...hidden];
    renderDelivery();
  });

  // 排障 / 自检用：只读快照，不提供任何写入口。
  globalThis.__STAGE2_REC__ = () => ({
    mode: state.recMode,
    method: state.rec?.method || null,
    combos: state.rec?.combos || 0,
    evals: state.rec?.evals || 0,
    rounds: state.rec?.rounds || 0,
    steps: (state.rec?.steps || []).map(
      (step) => `${step.typeCode}:${step.fromId}>${step.toId}:${step.gain.toFixed(4)}:${step.reason}`,
    ),
    baseline: state.rec?.baseline?.score ?? null,
    current: state.rec?.current?.score ?? null,
    ms: state.rec?.ms ?? null,
    note: state.rec?.note || "",
    bestStart: state.rec?.bestStart || "",
    starts: (state.rec?.starts || []).map((start) => ({
      id: start.id,
      label: start.label,
      from: start.from ?? null,
      score: start.score ?? null,
      steps: start.steps ?? 0,
      evals: start.evals ?? 0,
      rounds: start.rounds ?? 0,
      skipped: Boolean(start.skipped),
    })),
    marketPicks: state.rec?.marketPicks || [],
    system: Object.fromEntries(state.system),
  });

  /** 交付排期自检快照：任务、日期窗、预警线、分组交期，只读。 */
  globalThis.__STAGE2_DELIVERY__ = () => {
    const plan = state.lastDelivery || dlvPlan();
    return {
      basis: plan.basis,
      window: plan.window,
      stats: plan.stats,
      tasks: plan.tasks.map((task) => ({
        id: task.id,
        lane: task.lane,
        kind: task.kind,
        s: task.s,
        e: task.e,
        end: dlvEndOf(task),
        days: task.days,
        arrive: task.arrive ?? null,
        lead: task.lead ?? null,
        name: task.name,
      })),
      groups: plan.groups.map((group) => ({
        code: group.code,
        name: group.name,
        lead: group.lead,
        high: group.high,
        stage: group.stage,
        parts: group.rows.length,
      })),
      alerts: plan.alerts.map((alert) => ({ level: alert.level, day: alert.day, label: alert.label })),
    };
  };

  /**
   * 自检用：在"只取前 N 个零件类型"的裁剪空间上同时跑枚举、单起点爬山、多起点爬山。
   * 真实零件库有 1.0×10²⁸ 种组合，枚举跑不动；裁到 2–3 个类型（100–1000 种）就能
   * 精确求解，用来说明枚举这条路径是通的，并给出"爬山离最优还差多少"的经验证据。
   */
  globalThis.__STAGE2_SOLVER_CHECK__ = (typeCount = 3) => {
    const codes = [...state.partTypes.keys()].slice(0, Math.max(1, typeCount));
    const pool = new Map(codes.map((code) => [code, state.partTypes.get(code).variants || []]));
    const greedy = greedySelection(pool);
    const multi = multiStartSelection(pool);
    const exact = enumSelection(pool);
    return {
      types: pool.size,
      combos: comboSpace(pool),
      enumEvals: exact.evals,
      enumScore: exact.eval.score,
      greedyScore: greedy.eval.score,
      greedySteps: greedy.steps.length,
      multiScore: multi.eval.score,
      multiEvals: multi.evals,
      multiStarts: multi.starts.map((start) => ({ label: start.label, score: start.score })),
      multiBetter: multi.eval.score > greedy.eval.score + 1e-9,
      exactBetter: exact.eval.score > multi.eval.score + 1e-9,
    };
  };

  boot();
})();
