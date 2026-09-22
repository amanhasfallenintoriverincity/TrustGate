#!/usr/bin/env node
/**
 * Rebuilds the sandbox target image used by the container E2E tracer bullet.
 *
 * Idempotent: rerunning it rebuilds the same tag from the same Containerfile and
 * leaves no extra state behind. Extra arguments are forwarded to `podman build`
 * (for example `--no-cache`).
 *
 * This is a developer utility, so Podman is resolved through PATH (`PODMAN_BIN`
 * overrides it) instead of the absolute executable the sandbox runner pins for
 * its trust boundary.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const containerfile = "apps/demo-target/Containerfile.sandbox";
const image = "localhost/trustgate-target:sandbox";
const podman = process.env.PODMAN_BIN ?? "podman";

const fail = (message) => {
  process.stderr.write(`build-demo-image: ${message}\n`);
  process.exit(1);
};

const podmanBuildArgs = [
  "build",
  "--file",
  containerfile,
  "--tag",
  image,
  ...process.argv.slice(2),
  ".",
];

const build = spawnSync(podman, podmanBuildArgs, {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (build.error !== undefined) fail(`${podman} could not be executed: ${build.error.message}`);
if (build.status !== 0) fail(`podman build exited with code ${String(build.status)}`);

const inspect = spawnSync(podman, ["image", "inspect", image, "--format", "{{.Id}}"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
if (inspect.error !== undefined) {
  fail(`${podman} could not be executed: ${inspect.error.message}`);
}
if (inspect.status !== 0) fail(`image ${image} is missing after a successful build`);

process.stdout.write(
  `build-demo-image: ${image} (${inspect.stdout.trim()}) built from ${containerfile}\n`,
);
