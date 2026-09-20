export type SandboxMode = "vulnerable" | "patched";

export const SANDBOX_IMAGE_PATTERN =
  /^(?=.{1,255}$)(?!(?:containers-storage|dir|oci|docker-archive|oci-archive):)(?!.*::)(?!.*:\/\/)[A-Za-z0-9][A-Za-z0-9._+-]*(?::[0-9]+)?(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]*)?(?:@(sha256:[A-Fa-f0-9]{64}|sha512:[A-Fa-f0-9]{128}))?$/;
export const SANDBOX_NAME_SUFFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const assertImage: (image: unknown) => asserts image is string = (image) => {
  if (
    typeof image !== "string" ||
    image.length === 0 ||
    image.length > 255 ||
    !SANDBOX_IMAGE_PATTERN.test(image)
  ) {
    throw new TypeError("invalid sandbox image reference");
  }
};

const assertMode: (mode: unknown) => asserts mode is SandboxMode = (mode) => {
  if (mode !== "vulnerable" && mode !== "patched") {
    throw new TypeError("invalid sandbox mode");
  }
};

const assertNameSuffix: (nameSuffix: unknown) => asserts nameSuffix is string = (
  nameSuffix,
) => {
  if (
    typeof nameSuffix !== "string" ||
    !SANDBOX_NAME_SUFFIX_PATTERN.test(nameSuffix)
  ) {
    throw new TypeError("invalid sandbox name suffix");
  }
};

export const buildSandboxArgs = (
  image: string,
  mode: SandboxMode,
  nameSuffix?: string,
): readonly string[] => {
  assertImage(image);
  assertMode(mode);
  if (nameSuffix !== undefined) assertNameSuffix(nameSuffix);

  const name = `trustgate-target-${mode}${nameSuffix === undefined ? "" : `-${nameSuffix}`}`;

  return [
    "run",
    "--rm",
    "--name",
    name,
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
    `TARGET_MODE=${mode}`,
    "--env",
    "HOME=/tmp",
    "--env",
    "NODE_ENV=production",
    "--env",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "--workdir",
    "/app",
    image,
  ];
};
