# `@trustgate/contracts`

This package defines the bounded data contracts shared by TrustGate components.

## Untrusted ingress

Always call `parseContractJson(schema, serializedText)` when contract data enters from an untrusted source such as an LLM, HTTP request, stdin, worker, or external API.

```ts
import { analysisPlanSchema, parseContractJson } from "@trustgate/contracts";

const plan = parseContractJson(analysisPlanSchema, serializedText);
```

`parseContractJson` applies the fixed 256 KiB (262,144 UTF-8 byte) serialized-input cap **before** `JSON.parse` or schema validation. It then preserves the normal error distinctions: invalid JSON throws the native `SyntaxError`, while a valid JSON value that violates the contract throws `ZodError`.

Direct schema `.parse()` and `.safeParse()` calls are only for values already produced by trusted JSON parsing or trusted internal construction.

Arbitrary live JavaScript objects—including sparse arrays, getters, class instances, custom prototypes, functions, and `undefined`—are not accepted ingress representations. Process-global `Object.prototype` or `Array.prototype` tampering is also outside this package's threat model; arbitrary code able to perform that mutation has already compromised the Node.js process.

## Verdict boundary

An LLM may propose hypotheses and bounded test specifications, but it never decides that a hypothesis is `CONFIRMED`. The execution-result schema enforces the deterministic invariant that `CONFIRMED` requires both `executed === true` and non-empty execution evidence.
