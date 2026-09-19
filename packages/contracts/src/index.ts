import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JSON_MAX_DEPTH = 8;
export const JSON_MAX_ARRAY_LENGTH = 64;
export const JSON_MAX_RECORD_KEYS = 64;
export const JSON_MAX_STRING_LENGTH = 16_384;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const plainStrictObject = <
  Shape extends z.ZodRawShape,
  OptionalKey extends keyof Shape = never,
>(shape: Shape, optionalKeys: readonly OptionalKey[] = []) => {
  const shapeKeys = Object.keys(shape);
  const optionalKeySet = new Set<PropertyKey>(optionalKeys);
  const requiredKeys = shapeKeys.filter((key) => !optionalKeySet.has(key));

  type Output = z.core.$InferObjectOutput<Shape, {}>;
  const schema = createRuntimeSchema<Output>((value) => {
    if (!isPlainObject(value)) {
      return {
        success: false,
        issue: createRawIssue("Expected a plain object", value),
      };
    }

    for (const key of shapeKeys) {
      const prototypeDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, key);
      if (isStrongDescriptor(prototypeDescriptor)) {
        return {
          success: false,
          issue: createRawIssue(`Unsafe Object.prototype descriptor for field: ${key}`, value, [key]),
        };
      }
    }

    for (const key of requiredKeys) {
      if (!Object.hasOwn(value, key)) {
        return {
          success: false,
          issue: createRawIssue(`Required field must be an own property: ${key}`, value, [key]),
        };
      }
    }

    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(shape, key)) {
        return {
          success: false,
          issue: createRawIssue(`Unrecognized field: ${key}`, value, [key]),
        };
      }
    }

    const output = Object.create(null) as Record<string, unknown>;
    for (const key of shapeKeys) {
      if (!Object.hasOwn(value, key)) {
        continue;
      }
      if (optionalKeySet.has(key) && value[key] === undefined) {
        return {
          success: false,
          issue: createRawIssue(`Explicit undefined field is not allowed: ${key}`, value[key], [key]),
        };
      }
      const parsedField = safeParseSchema(shape[key]! as z.ZodType, value[key]);
      if (!parsedField.success) {
        return {
          success: false,
          issue: createRawIssue(`Invalid field: ${key}`, value[key], [key]),
        };
      }
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: parsedField.data,
        writable: true,
      });
    }

    for (const key of requiredKeys) {
      if (!Object.hasOwn(output, key)) {
        return {
          success: false,
          issue: createRawIssue(`Parsed field must be an own property: ${key}`, output, [key]),
        };
      }
    }
    return { success: true, data: output as Output };
  });
  return schema;
};

const isStrongDescriptor = (descriptor: PropertyDescriptor | undefined) => (
  descriptor !== undefined
  && ("get" in descriptor || "set" in descriptor || descriptor.writable === false)
);

const hasStrongNumericPrototypeDescriptor = () => (
  isStrongDescriptor(Object.getOwnPropertyDescriptor(Object.prototype, "0"))
  || isStrongDescriptor(Object.getOwnPropertyDescriptor(Array.prototype, "0"))
);

const defineOwnIndex = (array: unknown[], index: number, value: unknown) => {
  Object.defineProperty(array, index, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

const createSafeArray = (length = 0): unknown[] => {
  const array = new Array(length) as unknown[];
  if (!hasStrongNumericPrototypeDescriptor()) {
    return array;
  }

  const prototype = Object.create(Array.prototype) as Record<PropertyKey, unknown>;
  Object.defineProperty(prototype, "0", {
    configurable: true,
    value: undefined,
    writable: true,
  });
  Object.setPrototypeOf(array, prototype);
  return array;
};

const createRawIssue = (
  message: string,
  input: unknown,
  path?: PropertyKey[],
): z.core.$ZodRawIssue => ({
  code: "custom",
  input,
  message,
  ...(path === undefined ? {} : { path }),
});

const createRuntimeSchema = <Output>(
  parseValue: (value: unknown) =>
    | { success: true; data: Output }
    | { success: false; issue: z.core.$ZodRawIssue },
): z.ZodType<Output> => {
  const schema = new z.ZodType({ type: "custom" }) as z.ZodType<Output>;
  const runtimeParse = (payload: z.core.ParsePayload) => {
    const result = parseValue(payload.value);
    if (result.success) {
      payload.value = result.data;
      return payload;
    }

    const issues = createSafeArray();
    defineOwnIndex(issues, 0, result.issue);
    payload.issues = issues as z.core.$ZodRawIssue[];
    return payload;
  };
  Object.defineProperty(schema._zod, "parse", {
    configurable: true,
    value: runtimeParse,
    writable: true,
  });
  Object.defineProperty(schema._zod, "run", {
    configurable: true,
    value: runtimeParse,
    writable: true,
  });
  return schema;
};

const safeParseSchema = <Output>(schema: z.ZodType<Output>, value: unknown) => {
  const issues = createSafeArray();
  const payload = schema._zod.run(
    { value, issues: issues as z.core.$ZodRawIssue[] },
    { async: false, jitless: true },
  );
  if (payload instanceof Promise) {
    return { success: false as const };
  }
  return payload.issues.length === 0
    ? { success: true as const, data: payload.value as Output }
    : { success: false as const };
};

const denseArray = <Element extends z.ZodTypeAny>(
  elementSchema: Element,
  options: { min?: number; max: number },
): z.ZodType<z.output<Element>[]> => {
  const schema = createRuntimeSchema<z.output<Element>[]>((value) => {
    if (!Array.isArray(value)) {
      return {
        success: false,
        issue: createRawIssue("Expected an array", value),
      };
    }

    if (value.length > options.max) {
      return {
        success: false,
        issue: createRawIssue(`Array must contain at most ${options.max} items`, value),
      };
    }

    if (options.min !== undefined && value.length < options.min) {
      return {
        success: false,
        issue: createRawIssue(`Array must contain at least ${options.min} items`, value),
      };
    }

    const output = createSafeArray(value.length) as z.output<Element>[];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return {
          success: false,
          issue: createRawIssue("Array items must be own properties", value, [index]),
        };
      }

      const parsedElement = safeParseSchema(elementSchema, value[index]);
      if (!parsedElement.success) {
        return {
          success: false,
          issue: createRawIssue("Invalid array item", value[index], [index]),
        };
      }
      defineOwnIndex(output, index, parsedElement.data);
    }
    Object.setPrototypeOf(output, Array.prototype);
    return { success: true, data: output };
  });
  return schema;
};

const parseJsonValue = (
  value: unknown,
  depth: number,
): { success: true; data: JsonValue } | { success: false; issue: z.core.$ZodRawIssue } => {
  if (value === null || typeof value === "boolean") {
    return { success: true, data: value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { success: true, data: value }
      : { success: false, issue: createRawIssue("Expected a finite number", value) };
  }
  if (typeof value === "string") {
    return value.length <= JSON_MAX_STRING_LENGTH
      ? { success: true, data: value }
      : { success: false, issue: createRawIssue("JSON string is too long", value) };
  }

  if (depth === 0) {
    return { success: false, issue: createRawIssue("JSON nesting is too deep", value) };
  }

  if (Array.isArray(value)) {
    if (value.length > JSON_MAX_ARRAY_LENGTH) {
      return {
        success: false,
        issue: createRawIssue(`Array must contain at most ${JSON_MAX_ARRAY_LENGTH} items`, value),
      };
    }

    const output = createSafeArray(value.length) as JsonValue[];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return {
          success: false,
          issue: createRawIssue("Array items must be own properties", value, [index]),
        };
      }
      const parsedValue = parseJsonValue(value[index], depth - 1);
      if (!parsedValue.success) {
        return {
          success: false,
          issue: createRawIssue("Invalid JSON array item", value[index], [index]),
        };
      }
      defineOwnIndex(output, index, parsedValue.data);
    }
    Object.setPrototypeOf(output, Array.prototype);
    return { success: true, data: output };
  }

  if (!isPlainObject(value)) {
    return { success: false, issue: createRawIssue("Expected a JSON value", value) };
  }

  for (const key of Object.keys(value)) {
    if (isStrongDescriptor(Object.getOwnPropertyDescriptor(Object.prototype, key))) {
      return {
        success: false,
        issue: createRawIssue(`Unsafe Object.prototype descriptor for JSON key: ${key}`, value, [key]),
      };
    }
  }

  const keys = Object.keys(value);
  if (keys.length > JSON_MAX_RECORD_KEYS) {
    return { success: false, issue: createRawIssue("JSON object has too many keys", value) };
  }

  const output = Object.create(null) as Record<string, JsonValue>;
  for (const key of keys) {
    if (key.length > 256) {
      return { success: false, issue: createRawIssue("JSON object key is too long", key) };
    }
    const parsedValue = parseJsonValue(value[key], depth - 1);
    if (!parsedValue.success) {
      return {
        success: false,
        issue: createRawIssue("Invalid JSON object value", value[key], [key]),
      };
    }
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: parsedValue.data,
      writable: true,
    });
  }
  return { success: true, data: output };
};

const buildJsonValueSchema = (depth: number): z.ZodType<JsonValue> => (
  createRuntimeSchema<JsonValue>((value) => parseJsonValue(value, depth))
);

export const jsonValueSchema: z.ZodType<JsonValue> = buildJsonValueSchema(JSON_MAX_DEPTH);

export const requestSchema = plainStrictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().max(512).regex(/^\/api\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
  body: jsonValueSchema.optional(),
}, ["body"]);

const statusAssertionSchema = plainStrictObject({
  kind: z.literal("status"),
  equals: z.number().int().min(100).max(599),
});

const jsonEqualsAssertionSchema = plainStrictObject({
  kind: z.literal("json-equals"),
  path: z.string().max(512).regex(/^\$([.][A-Za-z0-9_-]+)*$/),
  equals: jsonValueSchema,
});

const stateDeltaAssertionSchema = plainStrictObject({
  kind: z.literal("state-delta"),
  key: z.enum(["balance", "inventoryCount", "ownerId"]),
  equals: jsonValueSchema,
});

export const assertionSchema = z.union([
  statusAssertionSchema,
  jsonEqualsAssertionSchema,
  stateDeltaAssertionSchema,
]);

export const testSpecSchema = plainStrictObject({
  id: z.string().regex(/^[a-z0-9-]{3,64}$/),
  request: requestSchema,
  assertions: denseArray(assertionSchema, { min: 1, max: 8 }),
});

const sourceEvidenceSchema = plainStrictObject({
  file: z.string().min(1).max(512),
  line: z.number().int().positive(),
  excerpt: z.string().max(300),
});

const hypothesisSchema = plainStrictObject({
  id: z.string().regex(/^[a-z0-9-]{3,64}$/),
  title: z.string().min(3).max(120),
  category: z.enum(["price-tampering", "ownership-bypass", "authorization-bypass"]),
  severity: z.enum(["critical", "high", "medium"]),
  evidence: denseArray(sourceEvidenceSchema, { min: 1, max: 8 }),
  tests: denseArray(testSpecSchema, { min: 1, max: 5 }),
});

export const analysisPlanSchema = plainStrictObject({
  version: z.literal(1),
  hypotheses: denseArray(hypothesisSchema, { min: 1, max: 10 }),
});

const executionEvidenceSchema = plainStrictObject({
  kind: z.string().min(1).max(64),
  expected: jsonValueSchema,
  actual: jsonValueSchema,
});

const executionResultObjectSchema = plainStrictObject({
  runId: z.string().min(1).max(128),
  hypothesisId: z.string().min(1).max(64),
  verdict: z.enum(["CONFIRMED", "BLOCKED", "UNVERIFIED", "ERROR"]),
  executed: z.boolean(),
  evidence: denseArray(executionEvidenceSchema, { max: 64 }),
});

export const executionResultSchema: z.ZodType<z.output<typeof executionResultObjectSchema>> =
  createRuntimeSchema((value) => {
    const parsedResult = safeParseSchema(executionResultObjectSchema, value);
    if (!parsedResult.success) {
      return {
        success: false,
        issue: createRawIssue("Invalid execution result", value),
      };
    }

    const data = parsedResult.data;
    if (data.verdict === "CONFIRMED" && !data.executed) {
      return {
        success: false,
        issue: createRawIssue("CONFIRMED requires executed=true", value),
      };
    }
    if (data.verdict === "CONFIRMED" && data.evidence.length === 0) {
      return {
        success: false,
        issue: createRawIssue("CONFIRMED requires at least one evidence item", value),
      };
    }
    return { success: true, data };
  });

export type Request = z.infer<typeof requestSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type TestSpec = z.infer<typeof testSpecSchema>;
export type AnalysisPlan = z.infer<typeof analysisPlanSchema>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;
