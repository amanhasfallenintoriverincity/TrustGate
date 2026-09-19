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

const plainObjectInputSchema = z.custom<Record<string, unknown>>(
  isPlainObject,
  { message: "Expected a plain object" },
);

const plainStrictObject = <
  Shape extends z.ZodRawShape,
  OptionalKey extends keyof Shape = never,
>(shape: Shape, optionalKeys: readonly OptionalKey[] = []) => {
  const optionalKeySet = new Set<PropertyKey>(optionalKeys);
  const requiredKeys = Object.keys(shape).filter((key) => !optionalKeySet.has(key));

  return z.preprocess(
    (value, ctx) => {
      if (!isPlainObject(value)) {
        ctx.addIssue({ code: "custom", message: "Expected a plain object" });
        return z.NEVER;
      }

      let missingRequiredKey = false;
      for (const key of requiredKeys) {
        if (!Object.hasOwn(value, key)) {
          missingRequiredKey = true;
          ctx.addIssue({
            code: "custom",
            message: `Required field must be an own property: ${key}`,
            path: [key],
          });
        }
      }
      if (missingRequiredKey) {
        return z.NEVER;
      }

      const ownValue = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(value)) {
        ownValue[key] = value[key];
      }
      return ownValue;
    },
    z.object(shape).strict(),
  );
};

const buildJsonValueSchema = (depth: number): z.ZodType<JsonValue> => {
  const scalarSchema = z.union([
    z.string().max(JSON_MAX_STRING_LENGTH),
    z.number().finite(),
    z.boolean(),
    z.null(),
  ]);

  if (depth === 0) {
    return scalarSchema;
  }

  const childSchema = buildJsonValueSchema(depth - 1);
  const recordSchema = plainObjectInputSchema
    .refine(
      (value) => Object.keys(value).length <= JSON_MAX_RECORD_KEYS,
      { message: `JSON objects may contain at most ${JSON_MAX_RECORD_KEYS} keys` },
    )
    .pipe(z.record(z.string(), childSchema));

  return z.union([
    scalarSchema,
    z.array(childSchema).max(JSON_MAX_ARRAY_LENGTH),
    recordSchema,
  ]);
};

export const jsonValueSchema: z.ZodType<JsonValue> = buildJsonValueSchema(JSON_MAX_DEPTH);

export const requestSchema = plainStrictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().max(512).regex(/^\/api\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
  body: jsonValueSchema.optional(),
}, ["body"]).refine(
  (value) => !(Object.hasOwn(value, "body") && value.body === undefined),
  { message: "Explicit undefined request bodies are not allowed", path: ["body"] },
);

const statusAssertionSchema = plainStrictObject({
  kind: z.literal("status"),
  equals: z.number().int().min(100).max(599),
});

const jsonEqualsAssertionSchema = plainStrictObject({
  kind: z.literal("json-equals"),
  path: z.string().regex(/^\$([.][A-Za-z0-9_-]+)*$/),
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
  assertions: z.array(assertionSchema).min(1).max(8),
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
  evidence: z.array(sourceEvidenceSchema).min(1).max(8),
  tests: z.array(testSpecSchema).min(1).max(5),
});

export const analysisPlanSchema = plainStrictObject({
  version: z.literal(1),
  hypotheses: z.array(hypothesisSchema).min(1).max(10),
});

const executionEvidenceSchema = plainStrictObject({
  kind: z.string().min(1).max(64),
  expected: jsonValueSchema,
  actual: jsonValueSchema,
});

export const executionResultSchema = plainStrictObject({
  runId: z.string().min(1).max(128),
  hypothesisId: z.string().min(1).max(64),
  verdict: z.enum(["CONFIRMED", "BLOCKED", "UNVERIFIED", "ERROR"]),
  executed: z.boolean(),
  evidence: z.array(executionEvidenceSchema).max(64),
}).superRefine((value, ctx) => {
  if (value.verdict === "CONFIRMED" && !value.executed) {
    ctx.addIssue({
      code: "custom",
      message: "CONFIRMED requires executed=true",
    });
  }

  if (value.verdict === "CONFIRMED" && value.evidence.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "CONFIRMED requires at least one evidence item",
    });
  }
});

export type Request = z.infer<typeof requestSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type TestSpec = z.infer<typeof testSpecSchema>;
export type AnalysisPlan = z.infer<typeof analysisPlanSchema>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;
