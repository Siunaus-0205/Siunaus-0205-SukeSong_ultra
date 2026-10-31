/**
 * 预设函数契约：AI 只能通过这 5 个函数影响后端。
 *
 *   judge_part_type    —— 详情页是否真的属于该零件类型
 *   extract_listing    —— 从详情页抽取厂家 / 型号 / 价格 / 销量 / 参数
 *   merge_market_part  —— 合并同款时确定显示名、厂家、型号、第四段编号
 *   judge_same_product —— 与现有型号是否同一商品（参数差异判断）
 *
 * 另有 3 个确定性函数（不经过 AI，但同样只能由函数入口调用）：
 *   exclude_price_outliers / submit_review / commit_market_part
 */

import { toolDefinition } from "./schema.mjs";

const paramsSchema = {
  type: "array",
  minItems: 1,
  maxItems: 12,
  items: {
    type: "object",
    required: ["label", "value"],
    additionalProperties: false,
    properties: {
      label: { type: "string", minLength: 1, maxLength: 12 },
      value: { type: "string", minLength: 1, maxLength: 60 },
    },
  },
};

export const TOOL_SCHEMAS = {
  judge_part_type: {
    type: "object",
    additionalProperties: false,
    required: ["partTypeCode", "belongs", "confidence", "reason"],
    properties: {
      partTypeCode: { type: "string", minLength: 3, maxLength: 40 },
      belongs: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string", minLength: 1, maxLength: 300 },
    },
  },
  extract_listing: {
    type: "object",
    additionalProperties: false,
    required: ["manufacturer", "model", "price", "monthlySales", "params", "confidence"],
    properties: {
      manufacturer: { type: "string", minLength: 1, maxLength: 80 },
      model: { type: "string", minLength: 1, maxLength: 80 },
      price: { type: "number", minimum: 0.01 },
      monthlySales: { type: "number", minimum: 0 },
      params: paramsSchema,
      spec: { type: "string", maxLength: 200 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
  merge_market_part: {
    type: "object",
    additionalProperties: false,
    required: [
      "manufacturer",
      "model",
      "displayName",
      "codeSuffix",
      "params",
      "confidence",
      "reason",
    ],
    properties: {
      manufacturer: { type: "string", minLength: 1, maxLength: 80 },
      model: { type: "string", minLength: 1, maxLength: 80 },
      displayName: { type: "string", minLength: 2, maxLength: 60 },
      codeSuffix: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,7}$" },
      params: paramsSchema,
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string", minLength: 1, maxLength: 300 },
    },
  },
  judge_same_product: {
    type: "object",
    additionalProperties: false,
    required: ["same", "confidence", "reason"],
    properties: {
      same: { type: "boolean" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string", minLength: 1, maxLength: 300 },
      priceDelta: { type: "number" },
      paramDelta: { type: "string", maxLength: 300 },
    },
  },
};

export const TOOL_DESCRIPTIONS = {
  judge_part_type:
    "判断一条商品详情是否真的属于指定零件类型。只依据详情页内容判断，标题只作参考。belongs=false 时说明原因。",
  extract_listing:
    "从商品详情页抽取结构化字段。manufacturer 是生产厂家/品牌，model 是厂家型号；价格取人民币单件价；monthlySales 是平台月销；params 是详情页里的重要参数原文（材质、尺寸、电压、接口、防护等），不要编造。",
  merge_market_part:
    "把同一厂家同一型号的多条在售商品合并为一个零件型号：确定显示名、厂家、型号、第四段编号（接在类型三段编号之后），并汇总关键参数。显示名用中文，格式类似“零件类型 · 型号”。",
  judge_same_product:
    "判断平台商品与现有零件型号是否同一商品。厂家与型号已相同，只需判断参数描述是否有实质差异；价格差异由调用方先给出，你只需确认参数。",
};

export function toolFor(name) {
  return toolDefinition(name, TOOL_DESCRIPTIONS[name], TOOL_SCHEMAS[name]);
}
