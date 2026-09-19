import { Buffer } from "node:buffer";

import {
  analysisPlanSchema,
  parseContractJson,
  type AnalysisPlan,
} from "@trustgate/contracts";
import type { LlmClient } from "@trustgate/llm-gateway";

import type { FileDiff } from "./diff-collector.js";
import type { ReviewInput } from "./ocr-adapter.js";
import { SECURITY_PLAN_SYSTEM } from "./prompts/security-plan.js";

export const PLANNER_INPUT_MAX_BYTES = 131_072;

export type PlannerInput = ReviewInput & { diffs: FileDiff[] };

type SerializedReview = {
  mode: ReviewInput["mode"];
  files: ReviewInput["files"];
  ruleGroups: ReviewInput["ruleGroups"];
};

type SerializedPlannerInput = {
  review: SerializedReview;
  diffs: FileDiff[];
};

const serializeInput = (input: PlannerInput): string => {
  if (input.files.length === 0 || input.diffs.length === 0) {
    throw new Error("review files and diffs must be non-empty");
  }

  const reviewPaths = new Set<string>();
  for (const [index, file] of input.files.entries()) {
    if (typeof file.path !== "string") {
      throw new TypeError(`review files[${index}].path must be a string`);
    }
    if (reviewPaths.has(file.path)) {
      throw new Error(`duplicate review file path: ${file.path}`);
    }
    reviewPaths.add(file.path);
  }

  if (input.ruleGroups.length === 0) {
    throw new Error("rule groups must be non-empty");
  }
  const groupedPaths = new Set<string>();
  for (const [groupIndex, group] of input.ruleGroups.entries()) {
    if (group.files.length === 0) {
      throw new Error(`ruleGroups[${groupIndex}].files must be non-empty`);
    }
    for (const [fileIndex, path] of group.files.entries()) {
      if (typeof path !== "string") {
        throw new TypeError(
          `ruleGroups[${groupIndex}].files[${fileIndex}] must be a string`,
        );
      }
      if (!reviewPaths.has(path)) {
        throw new Error(`unknown rule-group path: ${path}`);
      }
      if (groupedPaths.has(path)) {
        throw new Error(`duplicate rule-group path: ${path}`);
      }
      groupedPaths.add(path);
    }
  }
  for (const path of reviewPaths) {
    if (!groupedPaths.has(path)) {
      throw new Error(`missing rule-group path: ${path}`);
    }
  }

  const diffsByPath = new Map<string, FileDiff>();
  for (const [index, fileDiff] of input.diffs.entries()) {
    if (typeof fileDiff.path !== "string") {
      throw new TypeError(`diffs[${index}].path must be a string`);
    }
    if (diffsByPath.has(fileDiff.path)) {
      throw new Error(`duplicate diff path: ${fileDiff.path}`);
    }
    if (!reviewPaths.has(fileDiff.path)) {
      throw new Error(`unknown diff path: ${fileDiff.path}`);
    }
    if (typeof fileDiff.diff !== "string") {
      throw new TypeError(`diffs[${index}].diff must be a string`);
    }
    if (typeof fileDiff.truncated !== "boolean") {
      throw new TypeError(`diffs[${index}].truncated must be a boolean`);
    }
    diffsByPath.set(fileDiff.path, fileDiff);
  }

  const orderedDiffs = input.files.map(({ path }) => {
    const fileDiff = diffsByPath.get(path);
    if (fileDiff === undefined) {
      throw new Error(`missing diff path: ${path}`);
    }
    return {
      path: fileDiff.path,
      diff: fileDiff.diff,
      truncated: fileDiff.truncated,
    };
  });

  const serializedInput: SerializedPlannerInput = {
    review: {
      mode: input.mode,
      files: input.files.map(({ path, status, additions, deletions }) => ({
        path,
        status,
        additions,
        deletions,
      })),
      ruleGroups: input.ruleGroups.map(({ files, rules }) => ({
        files: [...files],
        rules,
      })),
    },
    diffs: orderedDiffs,
  };
  const serialized = JSON.stringify(serializedInput);
  if (Buffer.byteLength(serialized, "utf8") > PLANNER_INPUT_MAX_BYTES) {
    throw new RangeError(
      `Planner input exceeds ${PLANNER_INPUT_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return serialized;
};

export const createSecurityPlanner = (client: LlmClient) => ({
  async plan(input: PlannerInput): Promise<AnalysisPlan> {
    const serializedInput = serializeInput(input);
    const response = await client.generate({
      system: SECURITY_PLAN_SYSTEM,
      messages: [{ role: "user", content: serializedInput }],
      temperature: 0,
      maxTokens: 3000,
    });
    return parseContractJson(analysisPlanSchema, response.text);
  },
});
