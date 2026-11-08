/**
 * 零件表读写：presets/table1.json（结构） + public/data/h3-parts.json（型号）。
 *
 * 写回规则：
 *   1. 先跑完整校验；
 *   2. 备份当前文件；
 *   3. 原子替换；
 *   4. 任一步失败都保留/恢复备份，不让第二页读到半个文件。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readJson, timestampId } from "./store.mjs";
import { MAX_SECONDARY_LINKS, normalizeLinkUrl } from "./links.mjs";

export function loadTable1(config) {
  const doc = readJson(config.table1File, null);
  if (!doc) throw new Error(`读不到表1：${config.table1File}`);
  const productType = doc.productTypes?.[0];
  if (!productType) throw new Error("表1 没有 productTypes");
  const partTypes = [];
  for (const module of productType.modules || []) {
    for (const part of module.parts || []) {
      partTypes.push({
        code: part.code,
        name: part.name,
        qty: part.qty || 1,
        spec: part.spec || "",
        material: part.material || "",
        description: part.description || "",
        moduleCode: module.code,
        moduleName: module.name,
        keywords: [...(module.keywords || []), ...(part.keywords || [])],
      });
    }
  }
  return { doc, productType, partTypes };
}

export function loadParts(config) {
  const doc = readJson(config.partsFile, null);
  if (!doc) throw new Error(`读不到零件库：${config.partsFile}`);
  return doc;
}

export function indexParts(doc) {
  const types = new Map();
  const variants = new Map();
  for (const module of doc.modules || []) {
    for (const part of module.parts || []) {
      types.set(part.code, { ...part, moduleCode: module.code, moduleName: module.name });
      for (const variant of part.variants || []) {
        variants.set(variant.id, { ...variant, typeCode: part.code });
      }
    }
  }
  return { types, variants };
}

/** NFKC + 去空白/标点 + 小写：用于厂家/型号的同款判定。 */
export function normalizeKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[·・.,，。/\\\-_—–()（）[\]【】"'"'`]/g, "");
}

const REGION_PREFIX = /^[\u4e00-\u9fa5]{2,4}?(省|市|自治区|特区)/;
const CORP_SUFFIX = /(股份|集团|控股|实业|科技|技术|贸易|商贸|电子|光电|精密|智造|制造|有限|责任|公司)/g;

/**
 * 厂家名去掉地域前缀和「有限公司 / 科技」这类通用后缀。
 * AI 两次抽取同一个厂家可能一个给「深圳市多视界科技有限公司」，一个给「多视界」，
 * 归一后都变成「多视界」，才不会每跑一轮就多出一个重复型号。
 */
export function makerKey(value) {
  return normalizeKey(value).replace(REGION_PREFIX, "").replace(CORP_SUFFIX, "");
}

/** 厂家是否同一家：完全一致，或去掉地域/公司后缀后互为包含（型号必须另外完全一致）。 */
export function makerMatches(a, b) {
  const ka = normalizeKey(a);
  const kb = normalizeKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const ra = makerKey(a);
  const rb = makerKey(b);
  if (!ra || !rb) return false;
  if (ra === rb) return true;
  const [short, long] = ra.length <= rb.length ? [ra, rb] : [rb, ra];
  return short.length >= 2 && long.includes(short);
}

export function findVariantByMakerModel(doc, typeCode, manufacturer, model) {
  const modelKey = normalizeKey(model);
  if (!normalizeKey(manufacturer) || !modelKey) return null;
  for (const module of doc.modules || []) {
    for (const part of module.parts || []) {
      if (part.code !== typeCode) continue;
      for (const variant of part.variants || []) {
        if (normalizeKey(variant.model) !== modelKey) continue;
        if (makerMatches(variant.manufacturer, manufacturer)) {
          return { moduleCode: module.code, part, variant };
        }
      }
    }
  }
  return null;
}

/** 四段编号：类型三段编号 + AI 给的第四段；冲突时自动加序号。 */
export function allocateVariantId(doc, typeCode, suffix, { ignoreVariantId } = {}) {
  const clean = String(suffix || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 8);
  const base = clean || "m01";
  const existing = new Set();
  for (const module of doc.modules || []) {
    for (const part of module.parts || []) {
      for (const variant of part.variants || []) {
        if (variant.id !== ignoreVariantId) existing.add(variant.id);
      }
    }
  }
  let candidate = `${typeCode}-${base}`;
  let index = 2;
  while (existing.has(candidate)) {
    candidate = `${typeCode}-${base}-${index}`;
    index += 1;
  }
  return candidate;
}

export function findPart(doc, typeCode) {
  for (const module of doc.modules || []) {
    const part = (module.parts || []).find((item) => item.code === typeCode);
    if (part) return { module, part };
  }
  return null;
}

/**
 * 链接规则校验：1 条 primary=true + 至多 3 条 false、地址不能重复、只允许 http(s)。
 * 与 links.mjs 的写入规则一致，写盘前再兜一次底。
 */
export function validateVariantLinks(variant) {
  const errors = [];
  const links = Array.isArray(variant.links) ? variant.links : [];
  const id = variant.id || "?";
  if (links.length > MAX_SECONDARY_LINKS + 1) {
    errors.push(
      `型号 ${id} 的 links 有 ${links.length} 条，超过上限 ${MAX_SECONDARY_LINKS + 1}（1 条 true + ${MAX_SECONDARY_LINKS} 条 false）`,
    );
  }
  const primary = links.filter((link) => link && link.primary === true);
  const secondary = links.filter((link) => link && link.primary !== true);
  if (primary.length !== 1) {
    errors.push(`型号 ${id} 的 links 必须有 1 条标记为 true，实际 ${primary.length} 条`);
  }
  if (secondary.length > MAX_SECONDARY_LINKS) {
    errors.push(`型号 ${id} 的 links 有 ${secondary.length} 条标记为 false，超过上限 ${MAX_SECONDARY_LINKS}`);
  }
  const urls = new Set();
  for (const link of links) {
    const normalized = normalizeLinkUrl(link?.url);
    if (!normalized) {
      errors.push(`型号 ${id} 的 links 含非法地址：${JSON.stringify(link?.url ?? link)}`);
      continue;
    }
    if (urls.has(normalized)) errors.push(`型号 ${id} 的 links 有重复地址：${normalized}`);
    urls.add(normalized);
  }
  return errors;
}

export function validatePartsDocument(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object") return ["零件库不是对象"];
  const modules = doc.modules;
  if (!Array.isArray(modules) || modules.length === 0) errors.push("modules 为空");

  const typeCodes = new Set();
  const variantIds = new Set();
  const requiredVariantFields = ["id", "tier", "tierKey", "name", "price", "weight", "leadTime", "risk"];
  let typeCount = 0;
  let variantCount = 0;

  for (const module of modules || []) {
    if (!module.code || !module.name) errors.push(`模块缺少 code/name：${JSON.stringify(module.code)}`);
    for (const part of module.parts || []) {
      typeCount += 1;
      if (!part.code || !part.name) errors.push(`零件类型缺少 code/name：${module.code}`);
      if (typeCodes.has(part.code)) errors.push(`零件类型 code 重复：${part.code}`);
      typeCodes.add(part.code);
      if (!Array.isArray(part.variants) || part.variants.length === 0) {
        errors.push(`零件类型 ${part.code} 没有 variants`);
        continue;
      }
      if (!part.variants.some((variant) => variant.id === part.baselineVariantId)) {
        errors.push(`零件类型 ${part.code} 的 baselineVariantId 不存在`);
      }
      for (const variant of part.variants) {
        variantCount += 1;
        for (const field of requiredVariantFields) {
          if (variant[field] === undefined || variant[field] === null || variant[field] === "") {
            errors.push(`型号 ${variant.id || "?"} 缺少 ${field}`);
          }
        }
        if (variant.id && !String(variant.id).startsWith(`${part.code}-`)) {
          errors.push(`型号 id ${variant.id} 不属于类型 ${part.code}`);
        }
        if (variant.id && variantIds.has(variant.id)) errors.push(`型号 id 重复：${variant.id}`);
        variantIds.add(variant.id);
        for (const numeric of ["price", "weight", "leadTime"]) {
          if (variant[numeric] !== undefined && !Number.isFinite(Number(variant[numeric]))) {
            errors.push(`型号 ${variant.id} 的 ${numeric} 不是数字`);
          }
        }
        if (variant.links !== undefined && !Array.isArray(variant.links)) {
          errors.push(`型号 ${variant.id} 的 links 不是数组`);
        } else if (Array.isArray(variant.links) && variant.links.length > 0) {
          errors.push(...validateVariantLinks(variant));
        }
      }
    }
  }

  if (typeCount !== 28) errors.push(`零件类型应为 28，实际 ${typeCount}`);
  return errors;
}

export function writeParts(config, doc) {
  const errors = validatePartsDocument(doc);
  if (errors.length > 0) throw new Error(`零件库校验失败：\n- ${errors.join("\n- ")}`);

  mkdirSync(config.backupsDir, { recursive: true });
  const backup = join(config.backupsDir, `h3-parts-${timestampId()}.json`);
  if (existsSync(config.partsFile)) copyFileSync(config.partsFile, backup);

  const temp = `${config.partsFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, config.partsFile);
  } catch (error) {
    if (existsSync(backup)) copyFileSync(backup, config.partsFile);
    throw error;
  }
  return { backup };
}

export function readPartsRaw(config) {
  return readFileSync(config.partsFile, "utf8");
}
