import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SANDBOX_CONTAINERS_CONF,
  buildSandboxArgs,
  buildSandboxProcessPolicy,
} from "../src/sandbox-policy.js";

const image = "localhost/trustgate-target:test";
const hostRuntime = {
  home: "/home/trustgate-runner",
  xdgRuntimeDir: "/run/user/1000",
} as const;
const containersConfPath = "/run/user/1000/trustgate/containers.conf";

const vulnerableArgs = [
  "run",
  "--rm",
  "--interactive",
  "--name",
  "trustgate-target-vulnerable",
  "--pull",
  "never",
  "--http-proxy=false",
  "--env-host=false",
  "--privileged=false",
  "--cgroups",
  "enabled",
  "--unsetenv-all",
  "--network",
  "none",
  "--pid",
  "private",
  "--ipc",
  "private",
  "--uts",
  "private",
  "--cgroupns",
  "private",
  "--read-only",
  "--read-only-tmpfs=false",
  "--image-volume",
  "ignore",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,nodev,size=16m",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "64",
  "--memory",
  "256m",
  "--cpus",
  "0.5",
  "--user",
  "65532:65532",
  "--env",
  "TARGET_MODE=vulnerable",
  "--env",
  "HOME=/tmp",
  "--env",
  "NODE_ENV=production",
  "--env",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "--workdir",
  "/app",
  image,
] as const;

const patchedArgs = [
  "run",
  "--rm",
  "--interactive",
  "--name",
  "trustgate-target-patched",
  "--pull",
  "never",
  "--http-proxy=false",
  "--env-host=false",
  "--privileged=false",
  "--cgroups",
  "enabled",
  "--unsetenv-all",
  "--network",
  "none",
  "--pid",
  "private",
  "--ipc",
  "private",
  "--uts",
  "private",
  "--cgroupns",
  "private",
  "--read-only",
  "--read-only-tmpfs=false",
  "--image-volume",
  "ignore",
  "--tmpfs",
  "/tmp:rw,noexec,nosuid,nodev,size=16m",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "64",
  "--memory",
  "256m",
  "--cpus",
  "0.5",
  "--user",
  "65532:65532",
  "--env",
  "TARGET_MODE=patched",
  "--env",
  "HOME=/tmp",
  "--env",
  "NODE_ENV=production",
  "--env",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "--workdir",
  "/app",
  image,
] as const;

test("sandbox is rootless, offline, read-only and resource bounded", () => {
  const args = buildSandboxArgs(image, "vulnerable");

  for (const expected of [
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "64",
    "--memory",
    "256m",
    "--cpus",
    "0.5",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65532:65532",
  ]) {
    assert.equal(args.includes(expected), true, expected);
  }
  assert.equal(
    args.some(
      (value) =>
        value.includes(".codex") ||
        value.includes("API_KEY") ||
        value.includes("GITHUB_TOKEN"),
    ),
    false,
  );
});

test("vulnerable sandbox argv matches the exact policy snapshot", () => {
  assert.deepEqual(buildSandboxArgs(image, "vulnerable"), vulnerableArgs);
});

test("patched sandbox argv matches the exact policy snapshot", () => {
  assert.deepEqual(buildSandboxArgs(image, "patched"), patchedArgs);
});

test("sandbox names are deterministic and accept a conservative suffix", () => {
  const first = buildSandboxArgs(image, "patched", "probe-01");
  const second = buildSandboxArgs(image, "patched", "probe-01");

  assert.equal(
    first[first.indexOf("--name") + 1],
    "trustgate-target-patched-probe-01",
  );
  assert.deepEqual(first, second);
});

test("each call returns a fresh argv array without shared mutation", () => {
  const first = buildSandboxArgs(image, "vulnerable");
  const second = buildSandboxArgs(image, "vulnerable");

  assert.notStrictEqual(first, second);
  (first as string[]).push("--privileged");
  assert.deepEqual(second, vulnerableArgs);
  assert.deepEqual(buildSandboxArgs(image, "vulnerable"), vulnerableArgs);
});

test("invalid image references fail closed", () => {
  const invalidImages: unknown[] = [
    undefined,
    null,
    7,
    "",
    " ",
    "a".repeat(256),
    "-image:tag",
    "/image:tag",
    "image tag",
    "image\ntag",
    "image\ttag",
    "image\0tag",
    "image$tag",
  ];

  for (const invalidImage of invalidImages) {
    assert.throws(
      () => buildSandboxArgs(invalidImage as string, "vulnerable"),
      TypeError,
      String(invalidImage),
    );
  }
});

test("normal OCI references and the maximum image length are accepted", () => {
  const digest = `docker.io/library/node:24-alpine@sha256:${"a".repeat(64)}`;
  const maxLengthImage = `a${"b".repeat(254)}`;

  assert.equal(buildSandboxArgs(digest, "patched").at(-1), digest);
  assert.equal(
    buildSandboxArgs(maxLengthImage, "patched").at(-1),
    maxLengthImage,
  );
});

test("invalid sandbox modes fail closed", () => {
  for (const invalidMode of [
    undefined,
    null,
    "",
    "VULNERABLE",
    "patched ",
    1,
  ]) {
    assert.throws(
      () => buildSandboxArgs(image, invalidMode as "vulnerable"),
      TypeError,
      String(invalidMode),
    );
  }
});

test("invalid name suffixes fail closed", () => {
  for (const invalidSuffix of [
    null,
    "",
    "Probe",
    "-probe",
    "probe_name",
    "probe space",
    "probe\nname",
    "a".repeat(33),
  ]) {
    assert.throws(
      () => buildSandboxArgs(image, "vulnerable", invalidSuffix as string),
      TypeError,
      String(invalidSuffix),
    );
  }

  const maxLengthSuffix = `a${"b".repeat(31)}`;
  const args = buildSandboxArgs(image, "vulnerable", maxLengthSuffix);
  assert.equal(
    args[args.indexOf("--name") + 1],
    `trustgate-target-vulnerable-${maxLengthSuffix}`,
  );
});

test("policy options are not duplicated", () => {
  const args = buildSandboxArgs(image, "vulnerable");
  const singleOptions = [
    "--rm",
    "--interactive",
    "--name",
    "--pull",
    "--http-proxy=false",
    "--unsetenv-all",
    "--network",
    "--pid",
    "--ipc",
    "--uts",
    "--cgroupns",
    "--read-only",
    "--read-only-tmpfs=false",
    "--image-volume",
    "--tmpfs",
    "--cap-drop",
    "--security-opt",
    "--pids-limit",
    "--memory",
    "--cpus",
    "--user",
    "--workdir",
  ];

  for (const option of singleOptions) {
    assert.equal(args.filter((value) => value === option).length, 1, option);
  }
  assert.equal(args.filter((value) => value === "--env").length, 4);
});

test("policy contains no forbidden flags or secret substrings", () => {
  const args = buildSandboxArgs(image, "patched");
  const forbiddenOptions = new Set([
    "--mount",
    "--volume",
    "-v",
    "--device",
    "--publish",
    "-p",
    "--userns",
    "--env-file",
    "--secret",
  ]);
  const optionNames = args
    .filter((value) => value.startsWith("-"))
    .map((value) => value.split("=", 1)[0]);

  for (const option of optionNames) {
    assert.ok(option !== undefined);
    assert.equal(forbiddenOptions.has(option), false, option);
  }

  const joined = args.join("\n").toLowerCase();
  for (const secretLike of [
    ".codex",
    ".ssh",
    "api_key",
    "github_token",
    "aws_",
    "/home/",
    "password",
    "secret",
  ]) {
    assert.equal(joined.includes(secretLike), false, secretLike);
  }
});

test("the image is the final argv value after every Podman option", () => {
  const args = buildSandboxArgs(image, "patched");

  assert.equal(args.at(-1), image);
  assert.equal(args.indexOf(image), args.length - 1);
  assert.equal(args.filter((value) => value === image).length, 1);
});

test("environment allowlist contains exactly four fixed values", () => {
  const args = buildSandboxArgs(image, "patched");
  const environment: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--env") environment.push(args[index + 1]!);
  }

  assert.deepEqual(environment, [
    "TARGET_MODE=patched",
    "HOME=/tmp",
    "NODE_ENV=production",
    "PATH=/usr/local/bin:/usr/bin:/bin",
  ]);
  assert.deepEqual(
    environment.map((value) => value.slice(0, value.indexOf("="))),
    ["TARGET_MODE", "HOME", "NODE_ENV", "PATH"],
  );
});

test("tmpfs policy is exact and includes nodev", () => {
  const args = buildSandboxArgs(image, "vulnerable");

  assert.equal(
    args[args.indexOf("--tmpfs") + 1],
    "/tmp:rw,noexec,nosuid,nodev,size=16m",
  );
});

test("Podman host defaults are explicitly closed fail-safe", () => {
  const args = buildSandboxArgs(image, "vulnerable");

  for (const [option, value] of [
    ["--pull", "never"],
    ["--network", "none"],
    ["--pid", "private"],
    ["--ipc", "private"],
    ["--uts", "private"],
    ["--cgroupns", "private"],
    ["--image-volume", "ignore"],
    ["--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m"],
  ] as const) {
    const optionIndex = args.indexOf(option);
    assert.notEqual(optionIndex, -1, option);
    assert.equal(args[optionIndex + 1], value, option);
  }

  for (const option of [
    "--http-proxy=false",
    "--env-host=false",
    "--privileged=false",
    "--unsetenv-all",
    "--read-only",
    "--read-only-tmpfs=false",
  ]) {
    assert.equal(args.includes(option), true, option);
  }
});

test("host proxy credentials cannot enter the fixed environment allowlist", () => {
  const fakeHostEnvironment = {
    HTTP_PROXY: "http://proxy-user:proxy-password@proxy.invalid:8080",
    HTTPS_PROXY: "http://tls-user:tls-password@proxy.invalid:8443",
    NO_PROXY: "credential-marker.invalid",
  } as const;
  const previous = Object.fromEntries(
    Object.keys(fakeHostEnvironment).map((key) => [key, process.env[key]]),
  );

  try {
    Object.assign(process.env, fakeHostEnvironment);
    const args = buildSandboxArgs(image, "patched");
    const environment: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--env") environment.push(args[index + 1]!);
    }

    assert.deepEqual(environment, [
      "TARGET_MODE=patched",
      "HOME=/tmp",
      "NODE_ENV=production",
      "PATH=/usr/local/bin:/usr/bin:/bin",
    ]);
    assert.equal(args.includes("--http-proxy=false"), true);
    assert.equal(args.includes("--unsetenv-all"), true);
    assert.equal(args.includes("--env-host=false"), true);

    const joined = args.join("\n");
    for (const [key, value] of Object.entries(fakeHostEnvironment)) {
      assert.equal(joined.includes(key), false, key);
      assert.equal(joined.includes(value), false, value);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("policy source does not read the host environment or embed proxy credentials", () => {
  const source = readFileSync(
    new URL("../src/sandbox-policy.ts", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(source, /process\.env/);
  assert.equal(source.includes("--env-host=false"), true);
  assert.equal(source.includes("--env-host=true"), false);
  assert.equal(source.includes("--http-proxy=true"), false);
  for (const credential of [
    "proxy-user:proxy-password",
    "tls-user:tls-password",
    "credential-marker.invalid",
  ]) {
    assert.equal(source.includes(credential), false, credential);
  }
});

test("image references reject transports and malformed digests", () => {
  const invalidImages = [
    "docker://docker.io/library/node:24-alpine",
    "containers-storage:store",
    "containers-storage:localhost/trustgate-target:test",
    "dir:layout",
    "dir:/tmp/oci-layout",
    "oci:layout",
    "oci:/tmp/oci-layout",
    "docker-archive:image",
    "docker-archive:/tmp/image.tar",
    "oci-archive:image",
    "oci-archive:/tmp/image.tar",
    "image::tag",
    "localhost:5000/repository::tag",
    "image@sha256:xyz",
    `image@sha256:${"a".repeat(63)}`,
    `image@sha256:${"a".repeat(65)}`,
    `image@sha512:${"b".repeat(127)}`,
    `image@sha512:${"b".repeat(129)}`,
    `image@sha384:${"c".repeat(96)}`,
    `image@sha256:${"d".repeat(64)}@sha256:${"e".repeat(64)}`,
  ];

  for (const invalidImage of invalidImages) {
    assert.throws(
      () => buildSandboxArgs(invalidImage, "vulnerable"),
      TypeError,
      invalidImage,
    );
  }
});

test("valid sha256 digest image references are accepted", () => {
  const validImages = [
    `localhost/trustgate-target@sha256:${"a".repeat(64)}`,
    `registry.example.invalid:5000/team/target:v1@sha256:${"b".repeat(64)}`,
  ];

  for (const validImage of validImages) {
    assert.equal(buildSandboxArgs(validImage, "patched").at(-1), validImage);
  }
});

test(
  "process policy returns only trusted Podman process environment values",
  { concurrency: false },
  () => {
    const hostileEnvironment = {
      HTTP_PROXY: "http://proxy.invalid/credential",
      CONTAINERS_CONF: "/tmp/hostile.conf",
      CONTAINERS_CONF_OVERRIDE: "/tmp/hostile-override.conf",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/hostile-bus",
      REGISTRY_AUTH_FILE: "/tmp/hostile-auth.json",
    } as const;
    const previous = Object.fromEntries(
      Object.keys(hostileEnvironment).map((key) => [key, process.env[key]]),
    );

    try {
      Object.assign(process.env, hostileEnvironment);
      const first = buildSandboxProcessPolicy(
        image,
        "patched",
        containersConfPath,
        hostRuntime,
      );
      const second = buildSandboxProcessPolicy(
        image,
        "patched",
        containersConfPath,
        hostRuntime,
      );

      assert.deepEqual(first.env, {
        CONTAINERS_CONF: containersConfPath,
        HOME: hostRuntime.home,
        XDG_RUNTIME_DIR: hostRuntime.xdgRuntimeDir,
        PATH: "/usr/bin:/bin",
      });
      assert.deepEqual(Object.keys(first.env), [
        "CONTAINERS_CONF",
        "HOME",
        "XDG_RUNTIME_DIR",
        "PATH",
      ]);
      assert.notStrictEqual(first.env, second.env);
      assert.notStrictEqual(first.args, second.args);
      assert.deepEqual(first.args, buildSandboxArgs(image, "patched"));
      assert.equal(first.containersConf, SANDBOX_CONTAINERS_CONF);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test("process policy validates argv inputs before returning a launch policy", () => {
  assert.throws(
    () =>
      buildSandboxProcessPolicy(
        "repo..x",
        "patched",
        containersConfPath,
        hostRuntime,
      ),
    TypeError,
  );
  assert.throws(
    () =>
      buildSandboxProcessPolicy(
        image,
        "invalid" as "patched",
        containersConfPath,
        hostRuntime,
      ),
    TypeError,
  );
  assert.throws(
    () =>
      buildSandboxProcessPolicy(
        image,
        "patched",
        containersConfPath,
        hostRuntime,
        "Invalid",
      ),
    TypeError,
  );
});

test("trusted containers.conf pins secure Podman defaults", () => {
  assert.match(SANDBOX_CONTAINERS_CONF, /^\[containers\]$/m);
  assert.doesNotMatch(
    SANDBOX_CONTAINERS_CONF,
    /^(?:env|env_file|secret|label|annotation|log_driver|hooks_dir|devices|dns|network)\s*=/m,
  );
  for (const setting of [
    "env_host=false",
    "privileged=false",
    'cgroups="enabled"',
    "mounts=[]",
    "volumes=[]",
    "http_proxy=false",
    "read_only=true",
    "read_only_tmpfs=false",
    'image_volume_mode="ignore"',
    'ipcns="private"',
    'pidns="private"',
    'utsns="private"',
    'cgroupns="private"',
  ]) {
    const escaped = setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      SANDBOX_CONTAINERS_CONF,
      new RegExp(`^${escaped}$`, "m"),
      setting,
    );
  }
});

test("trusted containers.conf pins the cgroup manager for session-less runtimes", () => {
  assert.match(SANDBOX_CONTAINERS_CONF, /^\[engine\]$/m);
  assert.match(
    SANDBOX_CONTAINERS_CONF,
    /^cgroup_manager="cgroupfs"$/m,
    "a redirected XDG_RUNTIME_DIR has no systemd user session to warn about",
  );
  assert.ok(
    SANDBOX_CONTAINERS_CONF.indexOf("[containers]") <
      SANDBOX_CONTAINERS_CONF.indexOf("[engine]"),
    "the container defaults must keep the leading section",
  );
});

test(
  "Podman accepts the trusted config with the minimal process environment",
  {
    skip: process.env.RUN_PODMAN_E2E !== "1",
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "trustgate-info-"));
    const trustedConfig = join(root, "containers.conf");

    try {
      writeFileSync(trustedConfig, SANDBOX_CONTAINERS_CONF, { mode: 0o600 });
      const policy = buildSandboxProcessPolicy(
        image,
        "patched",
        trustedConfig,
        {
          home: homedir(),
          xdgRuntimeDir:
            process.env.XDG_RUNTIME_DIR ??
            `/run/user/${process.getuid?.() ?? 1000}`,
        },
      );
      const result = spawnSync("podman", ["info", "--format", "json"], {
        env: policy.env,
        encoding: "utf8",
      });

      assert.equal(result.status, 0, result.stderr);
      const info = JSON.parse(result.stdout) as {
        host: { security: { rootless: boolean } };
        version: { Version: string };
      };
      assert.equal(info.host.security.rootless, true);
      assert.match(info.version.Version, /^5\.8\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Podman host-sensitive defaults are explicitly overridden in argv", () => {
  const args = buildSandboxArgs(image, "vulnerable");

  assert.equal(args.includes("--env-host=false"), true);
  assert.equal(args.includes("--privileged=false"), true);
  assert.equal(args[args.indexOf("--cgroups") + 1], "enabled");
  assert.ok(
    args.indexOf("--http-proxy=false") < args.indexOf("--env-host=false"),
  );
  assert.ok(
    args.indexOf("--env-host=false") < args.indexOf("--privileged=false"),
  );
  assert.ok(args.indexOf("--privileged=false") < args.indexOf("--cgroups"));
  assert.ok(args.indexOf("--cgroups") < args.indexOf("--unsetenv-all"));
});

test("trusted Podman process paths fail closed", () => {
  const invalidPaths: unknown[] = [
    undefined,
    null,
    "",
    "relative/path",
    "/tmp/../tmp/containers.conf",
    "/tmp//containers.conf",
    "/tmp/containers conf",
    "/tmp/containers.conf\n",
    "/tmp/containers.conf\0",
    `/tmp/${"a".repeat(4092)}`,
  ];
  const maxPath = `/${"a".repeat(4095)}`;

  for (const invalidPath of invalidPaths) {
    assert.throws(
      () =>
        buildSandboxProcessPolicy(
          image,
          "patched",
          invalidPath as string,
          hostRuntime,
        ),
      TypeError,
      String(invalidPath),
    );
  }
  assert.throws(
    () => buildSandboxProcessPolicy(image, "patched", "/dev/null", hostRuntime),
    TypeError,
  );
  assert.equal(
    buildSandboxProcessPolicy(image, "patched", maxPath, {
      home: maxPath,
      xdgRuntimeDir: maxPath,
    }).env.CONTAINERS_CONF,
    maxPath,
  );
  let getterCalls = 0;
  const accessorRuntime = {
    get home() {
      getterCalls += 1;
      return hostRuntime.home;
    },
    xdgRuntimeDir: hostRuntime.xdgRuntimeDir,
  };
  for (const invalidRuntime of [
    null,
    [],
    Object.create(null),
    { home: hostRuntime.home },
    { ...hostRuntime, extra: "/tmp" },
    accessorRuntime,
  ]) {
    assert.throws(
      () =>
        buildSandboxProcessPolicy(
          image,
          "patched",
          containersConfPath,
          invalidRuntime as typeof hostRuntime,
        ),
      TypeError,
    );
  }
  assert.equal(getterCalls, 0);
  for (const [field, value] of [
    ["home", "relative/home"],
    ["home", "/home/../runner"],
    ["home", "/home/runner\n"],
    ["xdgRuntimeDir", "run/user/1000"],
    ["xdgRuntimeDir", "/run/user/../1000"],
    ["xdgRuntimeDir", `/run/${"a".repeat(4092)}`],
  ] as const) {
    assert.throws(
      () =>
        buildSandboxProcessPolicy(image, "patched", containersConfPath, {
          ...hostRuntime,
          [field]: value,
        }),
      TypeError,
      `${field}=${value}`,
    );
  }
});

test("OCI references use strict lowercase repository and sha256 grammar", () => {
  const invalidImages = [
    "repo..x",
    "repo___x",
    "repo-.-x",
    "repo/a..b",
    "Repo/image:tag",
    "registry.Example/image:tag",
    "registry.example:port/image:tag",
    "-image",
    "repo+name",
    "repo/image:tag+build",
    "repo/image:tag@",
    "repo/image@@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "repo/image@SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "docker:repo/image",
    "tarball:/tmp/image.tar",
    "sif:/tmp/image.sif",
    `repo@sha256:${"A".repeat(64)}`,
    `repo@sha512:${"a".repeat(128)}`,
  ];
  const validImages = [
    "busybox",
    "library/node:24-alpine",
    "localhost:5000/team/image_name.release-v1",
    "registry.example.invalid:5000/team/image__name:v1.2-rc_1",
    `docker.io/library/node:24-alpine@sha256:${"a".repeat(64)}`,
  ];

  for (const invalidImage of invalidImages) {
    assert.throws(
      () => buildSandboxArgs(invalidImage, "patched"),
      TypeError,
      invalidImage,
    );
  }
  for (const validImage of validImages) {
    assert.equal(buildSandboxArgs(validImage, "patched").at(-1), validImage);
  }
});

test(
  "OCI validation agrees with Podman parser outcomes",
  {
    skip: process.env.RUN_PODMAN_E2E !== "1",
  },
  () => {
    const acceptedMissing = [
      "repo:tag",
      "registry.example.invalid:5000/team/target:v1",
    ];
    const rejected = [
      "repo..x",
      "repo___x",
      "repo-.-x",
      "repo/a..b",
      `repo@sha256:${"A".repeat(64)}`,
    ];
    const runtimeEnvironment = {
      HOME: homedir(),
      XDG_RUNTIME_DIR:
        process.env.XDG_RUNTIME_DIR ??
        `/run/user/${process.getuid?.() ?? 1000}`,
      PATH: "/usr/bin:/bin",
    };

    for (const reference of acceptedMissing) {
      assert.doesNotThrow(
        () => buildSandboxArgs(reference, "patched"),
        reference,
      );
      const result = spawnSync(
        "podman",
        ["create", "--pull", "never", reference],
        { encoding: "utf8", env: runtimeEnvironment },
      );
      assert.equal(result.status, 125, `${reference}: ${result.stderr}`);
      assert.match(result.stderr, /image not known/, reference);
    }
    for (const reference of rejected) {
      assert.throws(
        () => buildSandboxArgs(reference, "patched"),
        TypeError,
        reference,
      );
      const result = spawnSync(
        "podman",
        ["create", "--pull", "never", reference],
        { encoding: "utf8", env: runtimeEnvironment },
      );
      assert.equal(result.status, 125, `${reference}: ${result.stderr}`);
      assert.match(
        result.stderr,
        /parsing reference|invalid checksum digest format/,
        reference,
      );
    }
  },
);

test(
  "trusted process policy runs the preserved image in both modes",
  {
    skip: process.env.RUN_PODMAN_E2E !== "1",
  },
  () => {
    for (const mode of ["vulnerable", "patched"] as const) {
      const root = mkdtempSync(join(tmpdir(), `trustgate-${mode}-`));
      const trustedConfig = join(root, "containers.conf");
      const runtime = {
        home: homedir(),
        xdgRuntimeDir:
          process.env.XDG_RUNTIME_DIR ??
          `/run/user/${process.getuid?.() ?? 1000}`,
      };

      try {
        writeFileSync(trustedConfig, SANDBOX_CONTAINERS_CONF, { mode: 0o600 });
        const policy = buildSandboxProcessPolicy(
          image,
          mode,
          trustedConfig,
          runtime,
          `${mode}-${process.pid}`,
        );
        const result = spawnSync("podman", policy.args, {
          env: policy.env,
          encoding: "utf8",
        });

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(result.stdout), {
          ok: true,
          component: "trustgate-target-image",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "missing images fail closed without a pull",
  {
    skip: process.env.RUN_PODMAN_E2E !== "1",
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "trustgate-missing-"));
    const trustedConfig = join(root, "containers.conf");
    const missingImage = `localhost/trustgate-missing-${process.pid}:never`;

    try {
      writeFileSync(trustedConfig, SANDBOX_CONTAINERS_CONF, { mode: 0o600 });
      const policy = buildSandboxProcessPolicy(
        missingImage,
        "patched",
        trustedConfig,
        {
          home: homedir(),
          xdgRuntimeDir:
            process.env.XDG_RUNTIME_DIR ??
            `/run/user/${process.getuid?.() ?? 1000}`,
        },
        `missing-${process.pid}`,
      );
      const result = spawnSync("podman", policy.args, {
        env: policy.env,
        encoding: "utf8",
      });

      assert.equal(result.status, 125, result.stderr);
      assert.match(result.stderr, /image not known/);
      const exists = spawnSync("podman", ["image", "exists", missingImage], {
        env: policy.env,
        encoding: "utf8",
      });
      assert.equal(exists.status, 1, exists.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "trusted config suppresses hostile user defaults in a real Podman create",
  {
    skip: process.env.RUN_PODMAN_E2E !== "1",
    concurrency: false,
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "trustgate-policy-"));
    const hostileConfig = join(root, "hostile-containers.conf");
    const hostileSecret = join(root, "host-secret.txt");
    const trustedConfig = join(root, "trusted-containers.conf");
    const containerName = `trustgate-target-patched-${process.pid}`;
    const unpinnedProbe = `trustgate-target-patched-unpinned-${process.pid}`;
    const runtime = {
      home: homedir(),
      xdgRuntimeDir:
        process.env.XDG_RUNTIME_DIR ??
        `/run/user/${process.getuid?.() ?? 1000}`,
    };
    const previousHostEnvironment = {
      CONTAINERS_CONF: process.env.CONTAINERS_CONF,
      CONTAINERS_CONF_OVERRIDE: process.env.CONTAINERS_CONF_OVERRIDE,
      HTTP_PROXY: process.env.HTTP_PROXY,
      LEAK_MARKER: process.env.LEAK_MARKER,
    };

    try {
      writeFileSync(hostileSecret, "host-mount-marker", { mode: 0o600 });
      writeFileSync(
        hostileConfig,
        `[containers]\nenv_host=true\nprivileged=true\ncgroups="disabled"\nmounts=["type=bind,source=${hostileSecret},destination=/host-secret,rw"]\nvolumes=["${hostileSecret}:/host-volume:rw"]\nhttp_proxy=true\n`,
        { mode: 0o600 },
      );
      writeFileSync(trustedConfig, SANDBOX_CONTAINERS_CONF, { mode: 0o600 });
      Object.assign(process.env, {
        CONTAINERS_CONF: hostileConfig,
        CONTAINERS_CONF_OVERRIDE: hostileConfig,
        HTTP_PROXY: "http://proxy-user:proxy-password@proxy.invalid:8080",
        LEAK_MARKER: "must-not-enter-container",
      });

      const policy = buildSandboxProcessPolicy(
        image,
        "patched",
        trustedConfig,
        runtime,
        `${process.pid}`,
      );
      const unpinnedEnvironment = {
        ...policy.env,
        CONTAINERS_CONF_OVERRIDE: hostileConfig,
      };
      assert.equal("CONTAINERS_CONF_OVERRIDE" in policy.env, false);
      const unpinnedArgs = [...policy.args];
      unpinnedArgs[0] = "create";
      unpinnedArgs.splice(unpinnedArgs.indexOf("--rm"), 1);
      unpinnedArgs[unpinnedArgs.indexOf("--name") + 1] = unpinnedProbe;
      const unpinnedCreated = spawnSync("podman", unpinnedArgs, {
        env: unpinnedEnvironment,
        encoding: "utf8",
      });
      assert.equal(unpinnedCreated.status, 0, unpinnedCreated.stderr);
      const unpinnedInspected = spawnSync(
        "podman",
        ["inspect", unpinnedProbe],
        {
          env: unpinnedEnvironment,
          encoding: "utf8",
        },
      );
      assert.equal(unpinnedInspected.status, 0, unpinnedInspected.stderr);
      const [unpinnedContainer] = JSON.parse(
        unpinnedInspected.stdout,
      ) as Array<{
        HostConfig: {
          Binds: string[] | null;
          Privileged: boolean;
          Cgroups: string;
        };
      }>;
      assert.ok(unpinnedContainer);
      assert.equal((unpinnedContainer.HostConfig.Binds ?? []).length, 2);
      assert.equal(unpinnedContainer.HostConfig.Privileged, false);
      assert.notEqual(unpinnedContainer.HostConfig.Cgroups, "disabled");

      const createArgs = [...policy.args];
      createArgs[0] = "create";
      createArgs.splice(createArgs.indexOf("--rm"), 1);
      const created = spawnSync("podman", createArgs, {
        env: policy.env,
        encoding: "utf8",
      });
      assert.equal(created.status, 0, created.stderr);
      assert.equal(policy.env.CONTAINERS_CONF, trustedConfig);
      assert.equal("CONTAINERS_CONF_OVERRIDE" in policy.env, false);
      assert.equal(Object.keys(policy.env).length, 4);
      assert.equal(policy.args.includes("--pull"), true);
      assert.equal(policy.args[policy.args.indexOf("--pull") + 1], "never");

      const inspected = spawnSync("podman", ["inspect", containerName], {
        env: policy.env,
        encoding: "utf8",
      });
      assert.equal(inspected.status, 0, inspected.stderr);
      const [container] = JSON.parse(inspected.stdout) as Array<{
        HostConfig: {
          Binds: string[] | null;
          Privileged: boolean;
          Cgroups: string;
        };
        Config: { Env: string[] };
      }>;
      assert.ok(container);
      assert.deepEqual(container.HostConfig.Binds ?? [], []);
      assert.equal(container.HostConfig.Privileged, false);
      assert.notEqual(container.HostConfig.Cgroups, "disabled");
      assert.equal(
        container.Config.Env.some((value) => value.includes("credential")),
        false,
      );
      assert.equal(
        container.Config.Env.some((value) => value.startsWith("HTTP_PROXY=")),
        false,
      );
      assert.equal(
        container.Config.Env.includes("LEAK_MARKER=must-not-enter-container"),
        false,
      );
    } finally {
      spawnSync("podman", ["rm", "-f", unpinnedProbe], {
        env: {
          CONTAINERS_CONF: trustedConfig,
          HOME: runtime.home,
          XDG_RUNTIME_DIR: runtime.xdgRuntimeDir,
          PATH: "/usr/bin:/bin",
        },
        encoding: "utf8",
      });
      spawnSync("podman", ["rm", "-f", containerName], {
        env: {
          CONTAINERS_CONF: trustedConfig,
          HOME: runtime.home,
          XDG_RUNTIME_DIR: runtime.xdgRuntimeDir,
          PATH: "/usr/bin:/bin",
        },
        encoding: "utf8",
      });
      for (const [key, value] of Object.entries(previousHostEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
