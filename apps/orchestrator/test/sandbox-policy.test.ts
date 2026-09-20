import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildSandboxArgs } from "../src/sandbox-policy.js";

const image = "localhost/trustgate-target:test";

const vulnerableArgs = [
  "run",
  "--rm",
  "--name",
  "trustgate-target-vulnerable",
  "--pull",
  "never",
  "--http-proxy=false",
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
  "--name",
  "trustgate-target-patched",
  "--pull",
  "never",
  "--http-proxy=false",
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

  assert.equal(first[first.indexOf("--name") + 1], "trustgate-target-patched-probe-01");
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
  assert.equal(buildSandboxArgs(maxLengthImage, "patched").at(-1), maxLengthImage);
});

test("invalid sandbox modes fail closed", () => {
  for (const invalidMode of [undefined, null, "", "VULNERABLE", "patched ", 1]) {
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
    "--privileged",
    "--userns",
    "--env-file",
    "--env-host",
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
    assert.equal(args.includes("--env-host"), false);

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
  assert.equal(source.includes("--env-host"), false);
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

test("valid sha256 and sha512 digest image references are accepted", () => {
  const validImages = [
    `localhost/trustgate-target@sha256:${"a".repeat(64)}`,
    `registry.example.invalid:5000/team/target:v1@sha256:${"b".repeat(64)}`,
    `docker.io/library/node@sha512:${"c".repeat(128)}`,
  ];

  for (const validImage of validImages) {
    assert.equal(buildSandboxArgs(validImage, "patched").at(-1), validImage);
  }
});
