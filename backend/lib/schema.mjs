/**
 * 极简 JSON Schema 校验器。
 *
 * 只覆盖本项目需要的关键字，但足够把"AI 输出"挡在函数契约之外：
 * AI 只能通过函数调用提交参数，参数不合法就直接拒绝，不会进入后端。
 */

const TYPES = {
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
};

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaError";
  }
}

function fail(path, message) {
  throw new SchemaError(`${path || "$"}：${message}`);
}

function checkType(schema, value, path) {
  const type = schema.type;
  if (!type) return;
  const candidates = Array.isArray(type) ? type : [type];
  if (!candidates.some((candidate) => TYPES[candidate]?.(value))) {
    fail(path, `期望 ${candidates.join(" / ")}，实际 ${Array.isArray(value) ? "array" : typeof value}`);
  }
}

export function validate(schema, value, path = "$") {
  if (!schema || typeof schema !== "object") return value;
  checkType(schema, value, path);

  if (schema.enum && !schema.enum.includes(value)) {
    fail(path, `必须是 ${schema.enum.join(" / ")} 之一`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    fail(path, `必须是 ${schema.const}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(path, `长度不能小于 ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(path, `长度不能超过 ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      fail(path, `不符合格式 ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, `不能小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, `不能大于 ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(path, `至少 ${schema.minItems} 项`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(path, `最多 ${schema.maxItems} 项`);
    }
    if (schema.items) value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
  }

  if (TYPES.object(value)) {
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null || value[key] === "") {
        fail(`${path}.${key}`, "必填");
      }
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined && value[key] !== null) {
        validate(child, value[key], `${path}.${key}`);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) fail(`${path}.${key}`, "不允许的字段");
      }
    }
  }

  return value;
}

export function assertSchema(schema, value) {
  return validate(schema, value);
}

export function toolDefinition(name, description, schema) {
  return {
    type: "function",
    function: { name, description, parameters: schema },
  };
}
