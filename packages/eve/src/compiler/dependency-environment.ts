import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const DEPENDENCY_ENVIRONMENT_FORMAT_VERSION = 1;
const LOCKFILE_NAMES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;
const PACKAGE_MANAGER_LOCKFILE: Readonly<Record<string, (typeof LOCKFILE_NAMES)[number]>> = {
  bun: "bun.lock",
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
};
const DEPENDENCY_PACKAGE_FIELDS = [
  "bundleDependencies",
  "bundledDependencies",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "overrides",
  "packageManager",
  "peerDependencies",
  "peerDependenciesMeta",
  "pnpm",
  "resolutions",
  "workspaces",
] as const;

interface DependencyEnvironmentFiles {
  readonly appPackageJsonPath?: string;
  readonly lockfilePath?: string;
  readonly rootPackageJsonPath?: string;
  readonly workspaceRoot: string;
}

/**
 * Hashes the package-manager inputs that define externally loaded package
 * behavior. The same digest is intentionally shared by every local node.
 */
export async function createDependencyEnvironmentDigest(appRoot: string): Promise<string> {
  const resolvedAppRoot = resolve(appRoot);
  const files = await discoverDependencyEnvironmentFiles(resolvedAppRoot);
  const roots = createRootReplacements(resolvedAppRoot, files.workspaceRoot);
  const appPackage = await readPackageJson(files.appPackageJsonPath);
  const rootPackage =
    files.rootPackageJsonPath === files.appPackageJsonPath
      ? appPackage
      : await readPackageJson(files.rootPackageJsonPath);
  const packageManager =
    readPackageManager(appPackage) ??
    readPackageManager(rootPackage) ??
    inferPackageManager(files.lockfilePath);
  const hash = createHash("sha256");

  hash.update(`eve-dependency-environment-v${DEPENDENCY_ENVIRONMENT_FORMAT_VERSION}\0`);
  updateHashPart(hash, "package-manager", packageManager);
  if (appPackage !== undefined) {
    updateHashPart(
      hash,
      "app-package",
      canonicalJson(canonicalizePaths(projectDependencyMetadata(appPackage), roots)),
    );
  }
  if (rootPackage !== undefined && files.rootPackageJsonPath !== files.appPackageJsonPath) {
    updateHashPart(
      hash,
      "workspace-package",
      canonicalJson(canonicalizePaths(projectDependencyMetadata(rootPackage), roots)),
    );
  }
  if (files.lockfilePath !== undefined) {
    updateHashPart(hash, "lockfile-name", basename(files.lockfilePath));
    updateHashPart(
      hash,
      "lockfile-bytes",
      canonicalizeLockfile(await readFile(files.lockfilePath), roots),
    );
  } else {
    updateHashPart(hash, "lockfile-name", "none");
  }

  return hash.digest("hex");
}

async function discoverDependencyEnvironmentFiles(
  appRoot: string,
): Promise<DependencyEnvironmentFiles> {
  const appPackageJsonPath = existingFile(join(appRoot, "package.json"));
  const appPackage = await readPackageJson(appPackageJsonPath);
  const preferredLockfile = resolvePreferredLockfileName(readPackageManager(appPackage));
  let current = appRoot;
  let workspaceRoot = appRoot;
  let lockfilePath: string | undefined;

  while (true) {
    const lockfiles = LOCKFILE_NAMES.map((name) => join(current, name)).filter(existsSync);
    if (lockfiles.length > 0) {
      workspaceRoot = current;
      lockfilePath = lockfiles.find((path) => basename(path) === preferredLockfile) ?? lockfiles[0];
      break;
    }

    if (existsSync(join(current, "pnpm-workspace.yaml")) || existsSync(join(current, ".git"))) {
      workspaceRoot = current;
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return {
    appPackageJsonPath,
    lockfilePath,
    rootPackageJsonPath: existingFile(join(workspaceRoot, "package.json")),
    workspaceRoot,
  };
}

function projectDependencyMetadata(packageJson: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    DEPENDENCY_PACKAGE_FIELDS.flatMap((field) =>
      packageJson[field] === undefined ? [] : [[field, packageJson[field]]],
    ),
  );
}

function createRootReplacements(
  appRoot: string,
  workspaceRoot: string,
): readonly (readonly [string, string])[] {
  const entries: Array<readonly [string, string]> = [
    [appRoot, "<app-root>"],
    [workspaceRoot, "<workspace-root>"],
    [appRoot.replaceAll("\\", "/"), "<app-root>"],
    [workspaceRoot.replaceAll("\\", "/"), "<workspace-root>"],
  ];
  return [...new Map(entries).entries()].sort((left, right) => right[0].length - left[0].length);
}

function canonicalizePaths(value: unknown, roots: readonly (readonly [string, string])[]): unknown {
  if (typeof value === "string") {
    return replaceRoots(value, roots);
  }
  if (Array.isArray(value)) {
    return value.map((child) => canonicalizePaths(child, roots));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, canonicalizePaths(child, roots)]),
  );
}

function canonicalizeLockfile(
  bytes: Buffer,
  roots: readonly (readonly [string, string])[],
): Buffer {
  if (bytes.includes(0)) {
    return bytes;
  }
  return Buffer.from(replaceRoots(bytes.toString("utf8"), roots));
}

function replaceRoots(value: string, roots: readonly (readonly [string, string])[]): string {
  let canonical = value;
  for (const [root, replacement] of roots) {
    canonical = canonical.replaceAll(root, replacement);
  }
  return canonical;
}

async function readPackageJson(
  path: string | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (path === undefined) {
    return undefined;
  }
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function readPackageManager(packageJson: Record<string, unknown> | undefined): string | undefined {
  return typeof packageJson?.packageManager === "string" ? packageJson.packageManager : undefined;
}

function resolvePreferredLockfileName(
  packageManager: string | undefined,
): (typeof LOCKFILE_NAMES)[number] | undefined {
  return packageManager === undefined
    ? undefined
    : PACKAGE_MANAGER_LOCKFILE[packageManager.split("@", 1)[0]!];
}

function inferPackageManager(lockfilePath: string | undefined): string {
  switch (basename(lockfilePath ?? "")) {
    case "pnpm-lock.yaml":
      return "pnpm";
    case "package-lock.json":
      return "npm";
    case "yarn.lock":
      return "yarn";
    case "bun.lock":
    case "bun.lockb":
      return "bun";
    default:
      return "unknown";
  }
}

function existingFile(path: string): string | undefined {
  return existsSync(path) ? path : undefined;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  );
}

function updateHashPart(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Buffer,
): void {
  hash.update(label);
  hash.update("\0");
  hash.update(String(Buffer.byteLength(value)));
  hash.update("\0");
  hash.update(value);
  hash.update("\0");
}
