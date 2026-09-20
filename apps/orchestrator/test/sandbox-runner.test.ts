import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTRACT_JSON_MAX_BYTES,
  type AnalysisPlan,
  type ExecutionResult,
} from "@trustgate/contracts";

import {
  createSandboxRunner,
  removePodmanSandboxContainer,
  runPodmanSandboxProcess,
  type SandboxCleanupExecutor,
  type SandboxCommandExecutor,
  type RunSandboxProcess,
} from "../src/sandbox-runner.js";
import {
  SANDBOX_CONTAINERS_CONF,
  type SandboxProcessPolicy,
} from "../src/sandbox-policy.js";

const image = "localhost/trustgate-target:sandbox";

type TestRunnerOptions = Parameters<typeof createSandboxRunner>[0];

const absentCleanupExecutor: SandboxCleanupExecutor = async (_file, args) => ({
  stdout: "",
  stderr: "",
  exitCode: args[0] === "container" ? 1 : 0,
});

const createTestSandboxRunner = (options: TestRunnerOptions) =>
  createSandboxRunner({
    cleanupExecutor: absentCleanupExecutor,
    ...options,
  });

const makePlan = (...testIds: string[]): AnalysisPlan => ({
  version: 1,
  hypotheses: [
    {
      id: "price-authority",
      title: "Server controls item prices",
      category: "price-tampering",
      severity: "high",
      evidence: [{ file: "src/store.ts", line: 1, excerpt: "price" }],
      tests: testIds.map((id) => ({
        id,
        request: {
          method: "POST",
          path: "/api/purchase",
          body: { itemId: "sword", price: -100 },
        },
        assertions: [
          { kind: "status", equals: 400 },
          { kind: "state-delta", key: "balance", equals: 0 },
        ],
      })),
    },
  ],
});

const makeResult = (
  testId: string,
  hypothesisId = "price-authority",
): ExecutionResult => ({
  runId: `spec-${testId}`,
  hypothesisId,
  verdict: "BLOCKED",
  executed: true,
  evidence: [],
});

const withRuntime = async (
  callback: (runtime: { home: string; xdgRuntimeDir: string }) => Promise<void>,
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "trustgate-runner-test-"));
  try {
    await callback({ home: "/home/trustgate-runner", xdgRuntimeDir: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const rejectionMessage = async (operation: Promise<unknown>): Promise<string> => {
  try {
    await operation;
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof Error);
    return error.message;
  }
};

test("runner snapshots a validated plan and sends only normalized JSON", async () => {
  await withRuntime(async (hostRuntime) => {
    const plan = makePlan("negative-price");
    let observedInput = "";
    const runner = createTestSandboxRunner({
      image,
      hostRuntime,
      runProcess: async (_policy, stdin) => {
        observedInput = stdin;
        plan.hypotheses[0]!.tests[0]!.request.path = "/api/transfer";
        return {
          stdout: JSON.stringify([makeResult("negative-price")]),
          stderr: "",
        };
      },
    });

    const results = await runner.run("vulnerable", plan);

    assert.deepEqual(JSON.parse(observedInput), makePlan("negative-price"));
    assert.equal(observedInput, JSON.stringify(JSON.parse(observedInput)));
    assert.deepEqual(results, [makeResult("negative-price")]);
  });
});

test("invalid and oversized plans fail before process or filesystem side effects", async () => {
  await withRuntime(async (hostRuntime) => {
    let processCalls = 0;
    const runner = createTestSandboxRunner({
      image,
      hostRuntime,
      runProcess: async () => {
        processCalls += 1;
        return { stdout: "[]", stderr: "" };
      },
    });
    const initialEntries = readFileSync("/proc/self/status", "utf8");
    assert.ok(initialEntries.length > 0);

    const malformed = { version: 1, hypotheses: [] } as AnalysisPlan;
    assert.equal(await rejectionMessage(runner.run("patched", malformed)), "sandbox plan rejected");

    const oversized = {
      ...makePlan("negative-price"),
      ignored: "x".repeat(CONTRACT_JSON_MAX_BYTES),
    } as AnalysisPlan;
    assert.equal(await rejectionMessage(runner.run("patched", oversized)), "sandbox plan rejected");
    assert.equal(processCalls, 0);
    assert.deepEqual(
      await (await import("node:fs/promises")).readdir(hostRuntime.xdgRuntimeDir),
      [],
    );
  });
});

test("plan serialization errors are generic and do not call the process", async () => {
  await withRuntime(async (hostRuntime) => {
    let processCalls = 0;
    const runner = createTestSandboxRunner({
      image,
      hostRuntime,
      runProcess: async () => {
        processCalls += 1;
        return { stdout: "[]", stderr: "" };
      },
    });
    const plan = makePlan("negative-price");
    Object.defineProperty(plan, "version", {
      enumerable: true,
      get() {
        throw new Error("secret-plan-marker");
      },
    });

    const message = await rejectionMessage(runner.run("vulnerable", plan));
    assert.equal(message, "sandbox plan rejected");
    assert.doesNotMatch(message, /secret-plan-marker/);
    assert.equal(processCalls, 0);
  });
});

test("invalid runtime and policy inputs fail before any filesystem write", async () => {
  const root = mkdtempSync(join(tmpdir(), "trustgate-runner-prereq-"));
  try {
    let calls = 0;
    const runProcess: RunSandboxProcess = async () => {
      calls += 1;
      return { stdout: "[]", stderr: "" };
    };
    const invalidImageRunner = createTestSandboxRunner({
      image: "-invalid-image",
      hostRuntime: { home: "/home/trustgate", xdgRuntimeDir: root },
      runProcess,
    });
    assert.equal(
      await rejectionMessage(invalidImageRunner.run("patched", makePlan("negative-price"))),
      "sandbox execution failed",
    );

    const missingRuntime = join(root, "missing");
    const missingRuntimeRunner = createTestSandboxRunner({
      image,
      hostRuntime: { home: "/home/trustgate", xdgRuntimeDir: missingRuntime },
      runProcess,
    });
    assert.equal(
      await rejectionMessage(missingRuntimeRunner.run("patched", makePlan("negative-price"))),
      "sandbox execution failed",
    );
    assert.equal(existsSync(missingRuntime), false);
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid real Podman path is rejected before filesystem side effects", async () => {
  await withRuntime(async (hostRuntime) => {
    const runner = createTestSandboxRunner({
      image,
      hostRuntime,
      podmanExecutable: "podman",
    });

    assert.equal(
      await rejectionMessage(runner.run("patched", makePlan("negative-price"))),
      "sandbox execution failed",
    );
    assert.deepEqual(
      await (await import("node:fs/promises")).readdir(hostRuntime.xdgRuntimeDir),
      [],
    );
  });
});

test("runner creates exact private config and cleans it after success", async () => {
  await withRuntime(async (hostRuntime) => {
    let configPath = "";
    let tempDirectory = "";
    const runner = createTestSandboxRunner({
      image,
      hostRuntime,
      runProcess: async (policy, stdin) => {
        configPath = policy.env.CONTAINERS_CONF!;
        tempDirectory = join(configPath, "..");
        const directoryStat = lstatSync(tempDirectory);
        const configStat = lstatSync(configPath);
        assert.equal(directoryStat.isDirectory(), true);
        assert.equal(directoryStat.mode & 0o777, 0o700);
        assert.equal(configStat.isFile(), true);
        assert.equal(configStat.isSymbolicLink(), false);
        assert.equal(configStat.mode & 0o777, 0o600);
        assert.equal(readFileSync(configPath, "utf8"), SANDBOX_CONTAINERS_CONF);
        assert.equal(policy.containersConf, SANDBOX_CONTAINERS_CONF);
        assert.deepEqual(Object.keys(policy.env).sort(), [
          "CONTAINERS_CONF",
          "HOME",
          "PATH",
          "XDG_RUNTIME_DIR",
        ]);
        assert.equal(policy.env.HOME, hostRuntime.home);
        assert.equal(policy.env.XDG_RUNTIME_DIR, hostRuntime.xdgRuntimeDir);
        assert.equal(policy.args.at(-1), image);
        assert.ok(policy.args.includes("TARGET_MODE=patched"));
        assert.ok(policy.args.includes("--interactive"));
        assert.deepEqual(JSON.parse(stdin), makePlan("negative-price"));
        return { stdout: JSON.stringify([makeResult("negative-price")]), stderr: "" };
      },
    });

    await runner.run("patched", makePlan("negative-price"));
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(tempDirectory), false);
  });
});

test("runner cleans private config and hides process errors", async () => {
  await withRuntime(async (hostRuntime) => {
    let configPath = "";
    const runner = createTestSandboxRunner({
      image,
      hostRuntime,
      runProcess: async (policy) => {
        configPath = policy.env.CONTAINERS_CONF!;
        throw new Error("raw-process-secret");
      },
    });

    const message = await rejectionMessage(runner.run("vulnerable", makePlan("negative-price")));
    assert.equal(message, "sandbox execution failed");
    assert.doesNotMatch(message, /raw-process-secret/);
    assert.equal(existsSync(configPath), false);
    assert.equal(existsSync(join(configPath, "..")), false);
  });
});

test("every launched runner path removes its exact policy container once", async () => {
  await withRuntime(async (hostRuntime) => {
    const cases: ReadonlyArray<{
      label: string;
      runProcess: RunSandboxProcess;
      expectedMessage?: string;
    }> = [
      {
        label: "success",
        runProcess: async () => ({
          stdout: JSON.stringify([makeResult("negative-price")]),
          stderr: "",
        }),
      },
      {
        label: "malformed stdout",
        runProcess: async () => ({ stdout: "not-json", stderr: "" }),
        expectedMessage: "sandbox execution failed",
      },
      {
        label: "stderr failure",
        runProcess: async () => ({
          stdout: JSON.stringify([makeResult("negative-price")]),
          stderr: "raw-stderr-secret",
        }),
        expectedMessage: "sandbox execution failed",
      },
      {
        label: "process rejection or timeout",
        runProcess: async () => {
          throw new Error("raw-timeout-secret");
        },
        expectedMessage: "sandbox execution failed",
      },
    ];

    for (const testCase of cases) {
      const cleanupCalls: Array<{
        file: string;
        args: readonly string[];
        options: Parameters<SandboxCleanupExecutor>[2];
      }> = [];
      let launchedPolicy: SandboxProcessPolicy | undefined;
      const cleanupExecutor: SandboxCleanupExecutor = async (file, args, options) => {
        cleanupCalls.push({ file, args, options });
        return {
          stdout: "",
          stderr: "",
          exitCode: args[0] === "container" ? 1 : 0,
        };
      };
      const runner = createTestSandboxRunner({
        image,
        hostRuntime,
        runProcess: async (policy, stdin) => {
          launchedPolicy = policy;
          return testCase.runProcess(policy, stdin);
        },
        cleanupExecutor,
      });

      if (testCase.expectedMessage === undefined) {
        assert.deepEqual(
          await runner.run("patched", makePlan("negative-price")),
          [makeResult("negative-price")],
          testCase.label,
        );
      } else {
        assert.equal(
          await rejectionMessage(runner.run("patched", makePlan("negative-price"))),
          testCase.expectedMessage,
          testCase.label,
        );
      }

      assert.ok(launchedPolicy, testCase.label);
      const nameIndex = launchedPolicy.args.indexOf("--name");
      assert.notEqual(nameIndex, -1, testCase.label);
      const containerName = launchedPolicy.args[nameIndex + 1];
      assert.match(
        containerName ?? "",
        /^trustgate-target-patched-[a-f0-9]{24}$/,
        testCase.label,
      );
      assert.equal(
        launchedPolicy.args.filter((value) => value === "--name").length,
        1,
        testCase.label,
      );
      assert.equal(
        cleanupCalls.filter((call) => call.args[0] === "rm").length,
        1,
        testCase.label,
      );
      assert.deepEqual(
        cleanupCalls.map((call) => call.args),
        [
          ["rm", "--force", "--ignore", "--time", "0", containerName],
          ["container", "exists", containerName],
        ],
        testCase.label,
      );
    }
  });
});

test("cleanup rejects a policy whose container name is ambiguous or untrusted", async () => {
  const env = {
    CONTAINERS_CONF: "/run/user/1000/trustgate/containers.conf",
    HOME: "/home/trustgate",
    XDG_RUNTIME_DIR: "/run/user/1000",
    PATH: "/usr/bin:/bin",
  };
  const policies: readonly SandboxProcessPolicy[] = [
    {
      args: [
        "run",
        "--name",
        "trustgate-target-patched-deadbeefdeadbeefdeadbeef",
        "--name",
        "trustgate-target-patched-cafebabecafebabecafebabe",
        image,
      ],
      env,
      containersConf: SANDBOX_CONTAINERS_CONF,
    },
    {
      args: ["run", "--name", "attacker-controlled", image],
      env,
      containersConf: SANDBOX_CONTAINERS_CONF,
    },
  ];

  for (const policy of policies) {
    let cleanupCalls = 0;
    assert.equal(
      await removePodmanSandboxContainer(
        policy,
        "/usr/bin/podman",
        async () => {
          cleanupCalls += 1;
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      ),
      false,
    );
    assert.equal(cleanupCalls, 0);
  }
});

test("cleanup uses the trusted Podman boundary and policy environment", async () => {
  await withRuntime(async (hostRuntime) => {
    const cleanupCalls: Array<{
      file: string;
      args: readonly string[];
      options: Parameters<SandboxCleanupExecutor>[2];
    }> = [];
    let launchedPolicy: SandboxProcessPolicy | undefined;
    const runner = createTestSandboxRunner({
      image,
      hostRuntime,
      podmanExecutable: "/opt/trusted/bin/podman",
      runProcess: async (policy) => {
        launchedPolicy = policy;
        return {
          stdout: JSON.stringify([makeResult("negative-price")]),
          stderr: "",
        };
      },
      cleanupExecutor: async (file, args, options) => {
        cleanupCalls.push({ file, args, options });
        return {
          stdout: args[0] === "container" ? "" : "raw-cleanup-stdout-secret",
          stderr: args[0] === "container" ? "" : "raw-cleanup-stderr-secret",
          exitCode: args[0] === "container" ? 1 : 0,
        };
      },
    });

    assert.deepEqual(await runner.run("vulnerable", makePlan("negative-price")), [
      makeResult("negative-price"),
    ]);
    assert.ok(launchedPolicy);
    assert.equal(cleanupCalls.length, 2);
    for (const call of cleanupCalls) {
      assert.equal(call.file, "/opt/trusted/bin/podman");
      assert.deepEqual(call.options, {
        cwd: "/",
        env: launchedPolicy.env,
        extendEnv: false,
        timeout: 5_000,
        reject: false,
        preferLocal: false,
        shell: false,
        encoding: "utf8",
        stripFinalNewline: false,
        maxBuffer: { stdout: 8_192, stderr: 8_192 },
      });
    }
  });
});

test("cleanup completes while the private config still exists", async () => {
  await withRuntime(async (hostRuntime) => {
    const events: string[] = [];
    let configPath = "";
    const cleanupExecutor: SandboxCleanupExecutor = async (_file, args, options) => {
      events.push(args[0] ?? "");
      assert.equal(existsSync(configPath), true);
      assert.equal(readFileSync(configPath, "utf8"), SANDBOX_CONTAINERS_CONF);
      assert.equal(
        (options.env as Readonly<Record<string, string>>).CONTAINERS_CONF,
        configPath,
      );
      return {
        stdout: "",
        stderr: "",
        exitCode: args[0] === "container" ? 1 : 0,
      };
    };
    const runner = createTestSandboxRunner({
      image,
      hostRuntime,
      runProcess: async (policy) => {
        events.push("run");
        configPath = policy.env.CONTAINERS_CONF!;
        return {
          stdout: JSON.stringify([makeResult("negative-price")]),
          stderr: "",
        };
      },
      cleanupExecutor,
    });

    await runner.run("patched", makePlan("negative-price"));

    events.push(existsSync(configPath) ? "config-present" : "config-deleted");
    assert.deepEqual(events, ["run", "rm", "container", "config-deleted"]);
  });
});

test("cleanup failure or a remaining container fails closed and still removes config", async () => {
  await withRuntime(async (hostRuntime) => {
    for (const scenario of [
      "cleanup rejected but absent",
      "cleanup rejected and existence unknown",
      "container remains",
    ] as const) {
      let configPath = "";
      const cleanupExecutor: SandboxCleanupExecutor = async (_file, args) => {
        if (args[0] === "rm" && scenario !== "container remains") {
          throw new Error("raw-cleanup-secret");
        }
        if (
          args[0] === "container" &&
          scenario === "cleanup rejected and existence unknown"
        ) {
          throw new Error("raw-exists-secret");
        }
        return {
          stdout: scenario === "container remains" ? "raw-name-secret" : "",
          stderr: scenario === "container remains" ? "raw-inspect-secret" : "",
          exitCode: scenario === "container remains" ? 0 : 1,
        };
      };
      const runner = createTestSandboxRunner({
        image,
        hostRuntime,
        runProcess: async (policy) => {
          configPath = policy.env.CONTAINERS_CONF!;
          return {
            stdout: JSON.stringify([makeResult("negative-price")]),
            stderr: "",
          };
        },
        cleanupExecutor,
      });

      if (scenario === "cleanup rejected but absent") {
        assert.deepEqual(await runner.run("patched", makePlan("negative-price")), [
          makeResult("negative-price"),
        ]);
      } else {
        const message = await rejectionMessage(
          runner.run("patched", makePlan("negative-price")),
        );
        assert.equal(message, "sandbox execution failed", scenario);
        assert.doesNotMatch(
          message,
          /raw-cleanup|raw-exists|raw-name|raw-inspect/,
          scenario,
        );
      }
      assert.equal(existsSync(configPath), false, scenario);
      assert.equal(existsSync(join(configPath, "..")), false, scenario);
    }
  });
});

test("each run uses a unique lowercase config path and container suffix", async () => {
  await withRuntime(async (hostRuntime) => {
    const paths: string[] = [];
    const names: string[] = [];
    const runProcess: RunSandboxProcess = async (policy) => {
      paths.push(policy.env.CONTAINERS_CONF!);
      names.push(policy.args[policy.args.indexOf("--name") + 1]!);
      return { stdout: JSON.stringify([makeResult("negative-price")]), stderr: "" };
    };
    const runner = createTestSandboxRunner({ image, hostRuntime, runProcess });

    await runner.run("patched", makePlan("negative-price"));
    await runner.run("patched", makePlan("negative-price"));

    assert.equal(new Set(paths).size, 2);
    assert.equal(new Set(names).size, 2);
    for (const value of paths) {
      assert.doesNotMatch(value.slice(hostRuntime.xdgRuntimeDir.length), /[A-Z]/);
    }
    for (const value of names) {
      assert.doesNotMatch(value, /[A-Z]/);
    }
  });
});

test("malformed, oversized, and schema-invalid stdout fail closed", async () => {
  await withRuntime(async (hostRuntime) => {
    for (const stdout of [
      "not-json raw-output-marker",
      " ".repeat(CONTRACT_JSON_MAX_BYTES + 1),
      JSON.stringify([{ ...makeResult("negative-price"), verdict: "UNKNOWN" }]),
      `${JSON.stringify([makeResult("negative-price")])}\nlog-line`,
    ]) {
      let calls = 0;
      const runner = createTestSandboxRunner({
        image,
        hostRuntime,
        runProcess: async () => {
          calls += 1;
          return { stdout, stderr: "" };
        },
      });
      const message = await rejectionMessage(runner.run("patched", makePlan("negative-price")));
      assert.equal(message, "sandbox execution failed");
      assert.doesNotMatch(message, /raw-output-marker|UNKNOWN|log-line/);
      assert.equal(calls, 1);
    }
  });
});

test("any stderr content, including whitespace, is rejected without disclosure", async () => {
  await withRuntime(async (hostRuntime) => {
    for (const stderr of ["sensitive stderr marker", " \n\t", "\n", "\r\n"]) {
      const runner = createTestSandboxRunner({
        image,
        hostRuntime,
        runProcess: async () => ({
          stdout: JSON.stringify([makeResult("negative-price")]),
          stderr,
        }),
      });

      const message = await rejectionMessage(
        runner.run("patched", makePlan("negative-price")),
      );
      assert.equal(message, "sandbox execution failed");
      assert.doesNotMatch(message, /sensitive/);
    }
  });
});

test("output cardinality, order, uniqueness, and identity are exact", async () => {
  await withRuntime(async (hostRuntime) => {
    const plan = makePlan("first-test", "second-test");
    const invalidOutputs = [
      [makeResult("first-test")],
      [makeResult("first-test"), makeResult("second-test"), makeResult("second-test")],
      [makeResult("second-test"), makeResult("first-test")],
      [makeResult("first-test"), makeResult("foreign-test")],
      [makeResult("first-test", "foreign-hypothesis"), makeResult("second-test")],
      [makeResult("first-test"), makeResult("first-test")],
    ];

    for (const output of invalidOutputs) {
      const runner = createTestSandboxRunner({
        image,
        hostRuntime,
        runProcess: async () => ({ stdout: JSON.stringify(output), stderr: "" }),
      });
      assert.equal(
        await rejectionMessage(runner.run("vulnerable", plan)),
        "sandbox execution failed",
      );
    }
  });
});

test("validated results are fresh values and the process is never retried", async () => {
  await withRuntime(async (hostRuntime) => {
    const processResult = {
      stdout: JSON.stringify([makeResult("negative-price")]),
      stderr: "",
    };
    let calls = 0;
    const runner = createTestSandboxRunner({
      image,
      hostRuntime,
      runProcess: async () => {
        calls += 1;
        return processResult;
      },
    });

    const first = await runner.run("patched", makePlan("negative-price"));
    first[0]!.runId = "mutated";
    const second = await runner.run("patched", makePlan("negative-price"));
    assert.equal(second[0]!.runId, "spec-negative-price");
    assert.equal(calls, 2);
  });
});

test("Podman executor uses an absolute binary and exact bounded execa options", async () => {
  const observed: { file?: string; args?: readonly string[]; options?: Record<string, unknown> } = {};
  const execute: SandboxCommandExecutor = async (file, args, options) => {
    observed.file = file;
    observed.args = args;
    observed.options = options as unknown as Record<string, unknown>;
    return { stdout: "[]", stderr: "" };
  };
  const policy = {
    args: ["run", "--rm", image],
    env: {
      CONTAINERS_CONF: "/run/user/1000/trustgate/containers.conf",
      HOME: "/home/trustgate",
      XDG_RUNTIME_DIR: "/run/user/1000",
      PATH: "/usr/bin:/bin",
    },
    containersConf: SANDBOX_CONTAINERS_CONF,
  } as const;

  assert.deepEqual(
    await runPodmanSandboxProcess(policy, "{\"version\":1}", "/usr/bin/podman", execute),
    { stdout: "[]", stderr: "" },
  );
  assert.equal(observed.file, "/usr/bin/podman");
  assert.deepEqual(observed.args, policy.args);
  assert.deepEqual(observed.options, {
    cwd: "/",
    env: policy.env,
    extendEnv: false,
    input: "{\"version\":1}",
    timeout: 30_000,
    reject: true,
    preferLocal: false,
    shell: false,
    encoding: "utf8",
    stripFinalNewline: false,
    maxBuffer: { stdout: 1_048_576, stderr: 8_192 },
  });
});

test("real execa preserves trailing LF and CRLF stderr", async () => {
  const policy = {
    args: [
      "-e",
      "const ending = process.argv[1]; process.stderr.write(ending === 'lf' ? '\\n' : '\\r\\n')",
      "lf",
    ],
    env: { PATH: "/usr/bin:/bin" },
    containersConf: SANDBOX_CONTAINERS_CONF,
  } as const;

  assert.deepEqual(
    await runPodmanSandboxProcess(policy, "", process.execPath),
    { stdout: "", stderr: "\n" },
  );
  assert.deepEqual(
    await runPodmanSandboxProcess(
      { ...policy, args: [...policy.args.slice(0, -1), "crlf"] },
      "",
      process.execPath,
    ),
    { stdout: "", stderr: "\r\n" },
  );
});

test("runner rejects invalid process timeout before filesystem side effects", async () => {
  await withRuntime(async (hostRuntime) => {
    for (const processTimeoutMs of [0, 30_001, 1.5, Number.NaN]) {
      let processCalls = 0;
      const runner = createTestSandboxRunner({
        image,
        hostRuntime,
        processTimeoutMs,
        runProcess: async () => {
          processCalls += 1;
          return { stdout: "[]", stderr: "" };
        },
      });

      assert.equal(
        await rejectionMessage(runner.run("patched", makePlan("negative-price"))),
        "sandbox execution failed",
      );
      assert.equal(processCalls, 0);
      assert.deepEqual(
        await (await import("node:fs/promises")).readdir(hostRuntime.xdgRuntimeDir),
        [],
      );
    }
  });
});

test("Podman executor rejects untrusted paths and masks subprocess failures", async () => {
  const policy = {
    args: ["run", image],
    env: {},
    containersConf: SANDBOX_CONTAINERS_CONF,
  } as const;
  let calls = 0;
  const execute: SandboxCommandExecutor = async () => {
    calls += 1;
    throw new Error("execa raw marker");
  };

  assert.equal(
    await rejectionMessage(runPodmanSandboxProcess(policy, "{}", "podman", execute)),
    "sandbox execution failed",
  );
  assert.equal(calls, 0);
  assert.equal(
    await rejectionMessage(runPodmanSandboxProcess(policy, "{}", "/usr/bin/podman", execute)),
    "sandbox execution failed",
  );
  assert.equal(calls, 1);
});
