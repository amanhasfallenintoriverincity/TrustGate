import { Buffer } from "node:buffer";

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
export const CONTRACT_JSON_MAX_BYTES = 262_144;

const jsonStringSchema = z.string().max(JSON_MAX_STRING_LENGTH);
const jsonNumberSchema = z.number().finite();
const jsonRecordKeySchema = z.string().max(256);

const buildJsonValueSchema = (depth: number): z.ZodType<JsonValue> => {
  const primitives = [jsonStringSchema, jsonNumberSchema, z.boolean(), z.null()] as const;

  if (depth === 0) {
    return z.union(primitives);
  }

  const child = buildJsonValueSchema(depth - 1);
  const record = z.record(jsonRecordKeySchema, child).refine(
    (value) => Object.keys(value).length <= JSON_MAX_RECORD_KEYS,
    { message: `JSON objects may contain at most ${JSON_MAX_RECORD_KEYS} keys` },
  );

  return z.union([
    ...primitives,
    z.array(child).max(JSON_MAX_ARRAY_LENGTH),
    record,
  ]);
};

export const jsonValueSchema: z.ZodType<JsonValue> = buildJsonValueSchema(JSON_MAX_DEPTH);

export function parseContractJson<Schema extends z.ZodType>(
  schema: Schema,
  text: string,
): z.output<Schema> {
  if (Buffer.byteLength(text, "utf8") > CONTRACT_JSON_MAX_BYTES) {
    throw new RangeError(
      `Serialized contract JSON exceeds ${CONTRACT_JSON_MAX_BYTES} UTF-8 bytes`,
    );
  }

  const value: unknown = JSON.parse(text);
  return schema.parse(value);
}

export const requestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().max(512).regex(/^\/api\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
  body: jsonValueSchema.optional(),
}).strict();

const statusAssertionSchema = z.object({
  kind: z.literal("status"),
  equals: z.number().int().min(100).max(599),
}).strict();

const jsonEqualsAssertionSchema = z.object({
  kind: z.literal("json-equals"),
  path: z.string().max(512).regex(/^\$([.][A-Za-z0-9_-]+)*$/),
  equals: jsonValueSchema,
}).strict();

const stateDeltaAssertionSchema = z.object({
  kind: z.literal("state-delta"),
  key: z.enum(["balance", "inventoryCount", "ownerId"]),
  equals: jsonValueSchema,
}).strict();

export const assertionSchema = z.union([
  statusAssertionSchema,
  jsonEqualsAssertionSchema,
  stateDeltaAssertionSchema,
]);

export const testSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,64}$/),
  request: requestSchema,
  assertions: z.array(assertionSchema).min(1).max(8),
}).strict();

const sourceEvidenceSchema = z.object({
  file: z.string().min(1).max(512),
  line: z.number().int().positive(),
  excerpt: z.string().max(300),
}).strict();

const hypothesisSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,64}$/),
  title: z.string().min(3).max(120),
  category: z.enum(["price-tampering", "ownership-bypass", "authorization-bypass"]),
  severity: z.enum(["critical", "high", "medium"]),
  evidence: z.array(sourceEvidenceSchema).min(1).max(8),
  tests: z.array(testSpecSchema).min(1).max(5),
}).strict();

export const analysisPlanSchema = z.object({
  version: z.literal(1),
  hypotheses: z.array(hypothesisSchema).min(1).max(10),
}).strict();

const executionEvidenceSchema = z.object({
  kind: z.string().min(1).max(64),
  expected: jsonValueSchema,
  actual: jsonValueSchema,
}).strict();

export const executionResultSchema = z.object({
  runId: z.string().min(1).max(128),
  hypothesisId: z.string().min(1).max(64),
  verdict: z.enum(["CONFIRMED", "BLOCKED", "UNVERIFIED", "ERROR"]),
  executed: z.boolean(),
  evidence: z.array(executionEvidenceSchema).max(64),
}).strict().superRefine((value, ctx) => {
  if (value.verdict === "CONFIRMED") {
    if (!value.executed) {
      ctx.addIssue({
        code: "custom",
        message: "CONFIRMED requires executed=true",
        path: ["executed"],
      });
    }

    if (value.evidence.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "CONFIRMED requires at least one evidence item",
        path: ["evidence"],
      });
    }
  }

  if (value.verdict === "BLOCKED") {
    if (!value.executed) {
      ctx.addIssue({
        code: "custom",
        message: "BLOCKED requires executed=true",
        path: ["executed"],
      });
    }

    if (value.evidence.length !== 0) {
      ctx.addIssue({
        code: "custom",
        message: "BLOCKED requires empty evidence",
        path: ["evidence"],
      });
    }
  }
});

export type Request = z.infer<typeof requestSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type TestSpec = z.infer<typeof testSpecSchema>;
export type AnalysisPlan = z.infer<typeof analysisPlanSchema>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;
