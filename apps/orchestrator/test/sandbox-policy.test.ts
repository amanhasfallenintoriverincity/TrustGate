import assert from "node:assert/strict";
import test from "node:test";

import { buildSandboxArgs } from "../src/sandbox-policy.js";

const image = "localhost/trustgate-target:test";

const vulnerableArgs = [
  "run",
  "--rm",
  "--name",
  "trustgate-target-vulnerable",
  "--network",
  "none",
  "--read-only",
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
  "--workdir",
  "/app",
  image,
] as const;

const patchedArgs = [
  "run",
  "--rm",
  "--name",
  "trustgate-target-patched",
  "--network",
  "none",
  "--read-only",
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
    "--network",
    "--read-only",
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
  assert.equal(args.filter((value) => value === "--env").length, 3);
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
    "--pid",
    "--ipc",
    "--uts",
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

test("environment allowlist contains exactly three fixed values", () => {
  const args = buildSandboxArgs(image, "patched");
  const environment: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--env") environment.push(args[index + 1]!);
  }

  assert.deepEqual(environment, [
    "TARGET_MODE=patched",
    "HOME=/tmp",
    "NODE_ENV=production",
  ]);
  assert.deepEqual(
    environment.map((value) => value.slice(0, value.indexOf("="))),
    ["TARGET_MODE", "HOME", "NODE_ENV"],
  );
});

test("tmpfs policy is exact and includes nodev", () => {
  const args = buildSandboxArgs(image, "vulnerable");

  assert.equal(
    args[args.indexOf("--tmpfs") + 1],
    "/tmp:rw,noexec,nosuid,nodev,size=16m",
  );
});
