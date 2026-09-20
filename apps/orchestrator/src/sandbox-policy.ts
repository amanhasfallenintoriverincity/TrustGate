import { isAbsolute, normalize } from "node:path";

export type SandboxMode = "vulnerable" | "patched";

export type SandboxHostRuntime = {
  home: string;
  xdgRuntimeDir: string;
};

export type SandboxProcessPolicy = {
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  containersConf: string;
};

export const SANDBOX_CONTAINERS_CONF = `[containers]
env_host=false
privileged=false
cgroups="enabled"
mounts=[]
volumes=[]
http_proxy=false
read_only=true
read_only_tmpfs=false
image_volume_mode="ignore"
ipcns="private"
pidns="private"
utsns="private"
cgroupns="private"
`;

const MAX_PATH_LENGTH = 4096;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;
const TRUSTED_PATH_PATTERN = /^[\x21-\x7e]+$/; // trusted runtime paths are ASCII
const REPOSITORY_COMPONENT_PATTERN =
  /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/;
const REGISTRY_HOST_PATTERN =
  /^(?:localhost|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/;
const TAG_PATTERN = /^\w[\w.-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TRANSPORT_PREFIX_PATTERN =
  /^(?:atomic|containers-storage|dir|docker|docker-archive|docker-daemon|oci|oci-archive|ostree|sif|tarball):/;

export const SANDBOX_IMAGE_PATTERN = /^(?=.{1,255}$)[^\x00-\x20\x7f]+$/;
export const SANDBOX_NAME_SUFFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const isValidRegistry = (candidate: string): boolean => {
  const separator = candidate.lastIndexOf(":");
  if (separator === -1) return REGISTRY_HOST_PATTERN.test(candidate);

  const host = candidate.slice(0, separator);
  const portText = candidate.slice(separator + 1);
  return REGISTRY_HOST_PATTERN.test(host) && /^\d+$/.test(portText);
};

const isValidImage = (image: string): boolean => {
  if (
    !SANDBOX_IMAGE_PATTERN.test(image) ||
    image.startsWith("-") ||
    TRANSPORT_PREFIX_PATTERN.test(image)
  ) {
    return false;
  }

  const digestParts = image.split("@");
  if (digestParts.length > 2) return false;
  const [nameAndTag, digest] = digestParts;
  if (nameAndTag === undefined || nameAndTag.length === 0) return false;
  if (digest !== undefined && !DIGEST_PATTERN.test(digest)) return false;

  const lastSlash = nameAndTag.lastIndexOf("/");
  const lastColon = nameAndTag.lastIndexOf(":");
  let repository = nameAndTag;
  if (lastColon > lastSlash) {
    const tag = nameAndTag.slice(lastColon + 1);
    if (!TAG_PATTERN.test(tag)) return false;
    repository = nameAndTag.slice(0, lastColon);
  }

  const components = repository.split("/");
  if (components.some((component) => component.length === 0)) return false;
  const [first, ...rest] = components;
  if (first === undefined) return false;
  const hasExplicitRegistry =
    components.length > 1 &&
    (first === "localhost" || first.includes(".") || first.includes(":"));
  const repositoryComponents = hasExplicitRegistry ? rest : components;
  if (hasExplicitRegistry && !isValidRegistry(first)) return false;
  return (
    repositoryComponents.length > 0 &&
    repositoryComponents.every((component) =>
      REPOSITORY_COMPONENT_PATTERN.test(component),
    )
  );
};

const assertImage: (image: unknown) => asserts image is string = (image) => {
  if (
    typeof image !== "string" ||
    image.length === 0 ||
    image.length > 255 ||
    !isValidImage(image)
  ) {
    throw new TypeError("invalid sandbox image reference");
  }
};

const assertTrustedAbsolutePath: (
  value: unknown,
  label: string,
  rejectDevNull?: boolean,
) => asserts value is string = (value, label, rejectDevNull = false) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !TRUSTED_PATH_PATTERN.test(value) ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    (rejectDevNull && value === "/dev/null")
  ) {
    throw new TypeError(`invalid ${label}`);
  }
};

const assertHostRuntime: (
  hostRuntime: unknown,
) => asserts hostRuntime is SandboxHostRuntime = (hostRuntime) => {
  if (
    typeof hostRuntime !== "object" ||
    hostRuntime === null ||
    Array.isArray(hostRuntime) ||
    Object.getPrototypeOf(hostRuntime) !== Object.prototype
  ) {
    throw new TypeError("invalid sandbox host runtime");
  }

  const keys = Object.keys(hostRuntime);
  const homeDescriptor = Object.getOwnPropertyDescriptor(hostRuntime, "home");
  const xdgRuntimeDescriptor = Object.getOwnPropertyDescriptor(
    hostRuntime,
    "xdgRuntimeDir",
  );
  if (
    keys.length !== 2 ||
    homeDescriptor === undefined ||
    !("value" in homeDescriptor) ||
    xdgRuntimeDescriptor === undefined ||
    !("value" in xdgRuntimeDescriptor)
  ) {
    throw new TypeError("invalid sandbox host runtime");
  }

  assertTrustedAbsolutePath(homeDescriptor.value, "sandbox host home");
  assertTrustedAbsolutePath(
    xdgRuntimeDescriptor.value,
    "sandbox host XDG runtime directory",
  );
};

const assertMode: (mode: unknown) => asserts mode is SandboxMode = (mode) => {
  if (mode !== "vulnerable" && mode !== "patched") {
    throw new TypeError("invalid sandbox mode");
  }
};

const assertNameSuffix: (
  nameSuffix: unknown,
) => asserts nameSuffix is string = (nameSuffix) => {
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

export const buildSandboxProcessPolicy = (
  image: string,
  mode: SandboxMode,
  containersConfPath: string,
  hostRuntime: SandboxHostRuntime,
  nameSuffix?: string,
): SandboxProcessPolicy => {
  assertTrustedAbsolutePath(
    containersConfPath,
    "sandbox containers.conf path",
    true,
  );
  assertHostRuntime(hostRuntime);
  const home = Object.getOwnPropertyDescriptor(hostRuntime, "home")!
    .value as string;
  const xdgRuntimeDir = Object.getOwnPropertyDescriptor(
    hostRuntime,
    "xdgRuntimeDir",
  )!.value as string;

  return {
    args: buildSandboxArgs(image, mode, nameSuffix),
    env: {
      CONTAINERS_CONF: containersConfPath,
      HOME: home,
      XDG_RUNTIME_DIR: xdgRuntimeDir,
      PATH: "/usr/bin:/bin",
    },
    containersConf: SANDBOX_CONTAINERS_CONF,
  };
};
