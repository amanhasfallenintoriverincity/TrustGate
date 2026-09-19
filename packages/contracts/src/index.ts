import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export const requestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().regex(/^\/api\/[a-zA-Z0-9/_-]*$/),
  body: jsonValueSchema.optional(),
}).strict();

export const assertionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    equals: z.number().int().min(100).max(599),
  }).strict(),
  z.object({
    kind: z.literal("json-equals"),
    path: z.string().regex(/^\$([.][A-Za-z0-9_-]+)*$/),
    equals: jsonValueSchema,
  }).strict(),
  z.object({
    kind: z.literal("state-delta"),
    key: z.enum(["balance", "inventoryCount", "ownerId"]),
    equals: jsonValueSchema,
  }).strict(),
]);

export const testSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,64}$/),
  request: requestSchema,
  assertions: z.array(assertionSchema).min(1).max(8),
}).strict();

export const analysisPlanSchema = z.object({
  version: z.literal(1),
  hypotheses: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{3,64}$/),
    title: z.string().min(3).max(120),
    category: z.enum(["price-tampering", "ownership-bypass", "authorization-bypass"]),
    severity: z.enum(["critical", "high", "medium"]),
    evidence: z.array(z.object({
      file: z.string().min(1),
      line: z.number().int().positive(),
      excerpt: z.string().max(300),
    }).strict()).min(1).max(8),
    tests: z.array(testSpecSchema).min(1).max(5),
  }).strict()).min(1).max(10),
}).strict();

export const executionResultSchema = z.object({
  runId: z.string().min(1),
  hypothesisId: z.string().min(1),
  verdict: z.enum(["CONFIRMED", "BLOCKED", "UNVERIFIED", "ERROR"]),
  executed: z.boolean(),
  evidence: z.array(z.object({
    kind: z.string(),
    expected: jsonValueSchema,
    actual: jsonValueSchema,
  }).strict()),
}).strict().superRefine((value, ctx) => {
  if (value.verdict === "CONFIRMED" && !value.executed) {
    ctx.addIssue({
      code: "custom",
      message: "CONFIRMED requires executed=true",
    });
  }
});

export type Request = z.infer<typeof requestSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type TestSpec = z.infer<typeof testSpecSchema>;
export type AnalysisPlan = z.infer<typeof analysisPlanSchema>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;
