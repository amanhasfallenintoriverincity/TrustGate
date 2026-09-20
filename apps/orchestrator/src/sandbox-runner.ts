import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

import {
  CONTRACT_JSON_MAX_BYTES,
  analysisPlanSchema,
  executionResultSchema,
  parseContractJson,
  type AnalysisPlan,
  type ExecutionResult,
} from "@trustgate/contracts";
import { execa } from "execa";

import {
  buildSandboxProcessPolicy,
  type SandboxHostRuntime,
  type SandboxMode,
  type SandboxProcessPolicy,
} from "./sandbox-policy.js";

const PLAN_ERROR_MESSAGE = "sandbox plan rejected";
const EXECUTION_ERROR_MESSAGE = "sandbox execution failed";
const DEFAULT_PODMAN_EXECUTABLE = "/usr/bin/podman";
const CONFIG_DIRECTORY_PREFIX = "trustgate-sandbox-";
const CONFIG_FILENAME = "containers.conf";
const CONFIG_DIRECTORY_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const PODMAN_TIMEOUT_MS = 30_000;
const STDOUT_MAX_BYTES = 1_048_576;
const STDERR_MAX_BYTES = 8_192;
const TRUSTED_EXECUTABLE_PATTERN = /^[\x21-\x7e]+$/;

export type SandboxProcessOutput = { stdout: string; stderr: string };

export type RunSandboxProcess = (
  policy: SandboxProcessPolicy,
  stdin: string,
) => Promise<SandboxProcessOutput>;

export type SandboxCommandExecutor = (
  file: string,
  args: readonly string[],
  options: SandboxCommandOptions,
) => Promise<SandboxProcessOutput>;

export type SandboxCommandOptions = {
  cwd: "/";
  env: Readonly<Record<string, string>>;
  extendEnv: false;
  input: string;
  timeout: 30_000;
  reject: true;
  preferLocal: false;
  shell: false;
  encoding: "utf8";
  maxBuffer: { stdout: 1_048_576; stderr: 8_192 };
};

export type SandboxRunnerOptions = {
  image: string;
  hostRuntime: SandboxHostRuntime;
  runProcess?: RunSandboxProcess;
  podmanExecutable?: string;
};

type ExpectedIdentity = { runId: string; hypothesisId: string };

const genericPlanError = (): Error => new Error(PLAN_ERROR_MESSAGE);
const genericExecutionError = (): Error => new Error(EXECUTION_ERROR_MESSAGE);

const assertTrustedExecutable: (value: unknown) => asserts value is string = (
  value,
) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    !TRUSTED_EXECUTABLE_PATTERN.test(value) ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    value === "/dev/null"
  ) {
    throw genericExecutionError();
  }
};

const isWithin = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(`${parent}${sep}`);

const snapshotPlan = (plan: AnalysisPlan): { plan: AnalysisPlan; stdin: string } => {
  try {
    const serialized = JSON.stringify(plan);
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized, "utf8") > CONTRACT_JSON_MAX_BYTES
    ) {
      throw genericPlanError();
    }
    const validated = parseContractJson(analysisPlanSchema, serialized);
    const stdin = JSON.stringify(validated);
    return { plan: validated, stdin };
  } catch {
    throw genericPlanError();
  }
};

const flattenIdentities = (plan: AnalysisPlan): ExpectedIdentity[] =>
  plan.hypotheses.flatMap((hypothesis) =>
    hypothesis.tests.map((spec) => ({
      runId: `spec-${spec.id}`,
      hypothesisId: hypothesis.id,
    })),
  );

const validateResults = (
  stdout: string,
  expected: readonly ExpectedIdentity[],
): ExecutionResult[] => {
  try {
    if (Buffer.byteLength(stdout, "utf8") > STDOUT_MAX_BYTES) {
      throw genericExecutionError();
    }
    const results = parseContractJson(
      executionResultSchema.array().max(50),
      stdout,
    );
    if (results.length !== expected.length) throw genericExecutionError();

    const seen = new Set<string>();
    results.forEach((result, index) => {
      const identity = `${result.hypothesisId}\u0000${result.runId}`;
      const expectedIdentity = expected[index];
      if (
        expectedIdentity === undefined ||
        result.runId !== expectedIdentity.runId ||
        result.hypothesisId !== expectedIdentity.hypothesisId ||
        seen.has(identity)
      ) {
        throw genericExecutionError();
      }
      seen.add(identity);
    });

    return results;
  } catch {
    throw genericExecutionError();
  }
};

const defaultCommandExecutor: SandboxCommandExecutor = async (
  file,
  args,
  options,
) => {
  const result = await execa(file, args, options);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export const runPodmanSandboxProcess = async (
  policy: SandboxProcessPolicy,
  stdin: string,
  podmanExecutable = DEFAULT_PODMAN_EXECUTABLE,
  execute: SandboxCommandExecutor = defaultCommandExecutor,
): Promise<SandboxProcessOutput> => {
  try {
    assertTrustedExecutable(podmanExecutable);
    return await execute(podmanExecutable, policy.args, {
      cwd: "/",
      env: policy.env,
      extendEnv: false,
      input: stdin,
      timeout: PODMAN_TIMEOUT_MS,
      reject: true,
      preferLocal: false,
      shell: false,
      encoding: "utf8",
      maxBuffer: { stdout: STDOUT_MAX_BYTES, stderr: STDERR_MAX_BYTES },
    });
  } catch {
    throw genericExecutionError();
  }
};

const createPrivateConfig = async (
  runtimeDir: string,
  contents: string,
  suffix: string,
): Promise<{ directory: string; path: string; suffix: string }> => {
  let directory = "";
  try {
    const trustedRuntime = await realpath(runtimeDir);
    const runtimeStat = await lstat(trustedRuntime);
    if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
      throw genericExecutionError();
    }

    directory = join(
      trustedRuntime,
      `${CONFIG_DIRECTORY_PREFIX}${suffix}`,
    );
    if (!isWithin(trustedRuntime, directory) || dirname(directory) !== trustedRuntime) {
      throw genericExecutionError();
    }
    await mkdir(directory, { mode: CONFIG_DIRECTORY_MODE });

    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw genericExecutionError();
    }
    await chmod(directory, CONFIG_DIRECTORY_MODE);
    const checkedDirectoryStat = await lstat(directory);
    if ((checkedDirectoryStat.mode & 0o777) !== CONFIG_DIRECTORY_MODE) {
      throw genericExecutionError();
    }

    const path = join(directory, CONFIG_FILENAME);
    const handle = await open(path, "wx", CONFIG_FILE_MODE);
    try {
      await handle.writeFile(contents, { encoding: "utf8" });
      await handle.sync();
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || (fileStat.mode & 0o777) !== CONFIG_FILE_MODE) {
        throw genericExecutionError();
      }
    } finally {
      await handle.close();
    }
    const pathStat = await lstat(path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw genericExecutionError();
    }
    return { directory, path, suffix };
  } catch {
    if (directory !== "") {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw genericExecutionError();
  }
};

const uniqueSuffix = (): string => randomBytes(12).toString("hex");

export const createSandboxRunner = (options: SandboxRunnerOptions) => {
  const podmanExecutable = options.podmanExecutable ?? DEFAULT_PODMAN_EXECUTABLE;
  const runProcess: RunSandboxProcess =
    options.runProcess ??
    ((policy, stdin) =>
      runPodmanSandboxProcess(policy, stdin, podmanExecutable));

  return {
    async run(mode: SandboxMode, inputPlan: AnalysisPlan): Promise<ExecutionResult[]> {
      const { plan, stdin } = snapshotPlan(inputPlan);
      const expected = flattenIdentities(plan);
      let privateConfig:
        | { directory: string; path: string; suffix: string }
        | undefined;

      try {
        if (options.runProcess === undefined) {
          assertTrustedExecutable(podmanExecutable);
        }
        const suffix = uniqueSuffix();
        const configPath = join(
          options.hostRuntime.xdgRuntimeDir,
          `${CONFIG_DIRECTORY_PREFIX}${suffix}`,
          CONFIG_FILENAME,
        );
        const policy = buildSandboxProcessPolicy(
          options.image,
          mode,
          configPath,
          options.hostRuntime,
          suffix,
        );
        privateConfig = await createPrivateConfig(
          options.hostRuntime.xdgRuntimeDir,
          policy.containersConf,
          suffix,
        );
        if (privateConfig.path !== configPath) throw genericExecutionError();
        const output = await runProcess(policy, stdin);
        if (output.stderr !== "") throw genericExecutionError();
        return validateResults(output.stdout, expected);
      } catch {
        throw genericExecutionError();
      } finally {
        if (privateConfig !== undefined) {
          try {
            await rm(privateConfig.directory, { recursive: true, force: true });
          } catch {
            throw genericExecutionError();
          }
        }
      }
    },
  };
};
