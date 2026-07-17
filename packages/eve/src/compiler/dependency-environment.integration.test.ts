import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDependencyEnvironmentDigest } from "#compiler/dependency-environment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
  );
});

describe("createDependencyEnvironmentDigest", () => {
  it("is relocation-stable across an app and workspace dependency environment", async () => {
    const first = await createWorkspace();
    const second = await createWorkspace();

    expect(await createDependencyEnvironmentDigest(second.appRoot)).toBe(
      await createDependencyEnvironmentDigest(first.appRoot),
    );
  });

  it("changes for dependency metadata and lockfile bytes but ignores unrelated fields", async () => {
    const workspace = await createWorkspace();
    const baseline = await createDependencyEnvironmentDigest(workspace.appRoot);
    const appPackagePath = join(workspace.appRoot, "package.json");
    const appPackage = JSON.parse(await readFile(appPackagePath, "utf8")) as Record<
      string,
      unknown
    >;

    await writeFile(
      appPackagePath,
      `${JSON.stringify({ ...appPackage, scripts: { lint: "echo ok" } })}\n`,
    );
    expect(await createDependencyEnvironmentDigest(workspace.appRoot)).toBe(baseline);

    await writeFile(
      appPackagePath,
      `${JSON.stringify({ ...appPackage, dependencies: { example: "2.0.0" } })}\n`,
    );
    expect(await createDependencyEnvironmentDigest(workspace.appRoot)).not.toBe(baseline);

    await writeFile(appPackagePath, `${JSON.stringify(appPackage)}\n`);
    await writeFile(join(workspace.root, "pnpm-lock.yaml"), "lockfileVersion: '9.1'\n");
    expect(await createDependencyEnvironmentDigest(workspace.appRoot)).not.toBe(baseline);
  });
});

async function createWorkspace(): Promise<{ readonly appRoot: string; readonly root: string }> {
  const root = await mkdtemp(join(tmpdir(), "eve-dependency-environment-"));
  const appRoot = join(root, "apps", "crm");
  roots.push(root);
  await mkdir(appRoot, { recursive: true });
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ packageManager: "pnpm@11.7.0", pnpm: { overrides: { transitive: "1.0.0" } } })}\n`,
  );
  await writeFile(
    join(appRoot, "package.json"),
    `${JSON.stringify({ dependencies: { example: "1.0.0" }, name: "crm" })}\n`,
  );
  await writeFile(
    join(root, "pnpm-lock.yaml"),
    ["lockfileVersion: '9.0'", `workspaceRoot: ${root}`, `appRoot: ${appRoot}`, ""].join("\n"),
  );
  await writeFile(join(appRoot, "unrelated.txt"), "not an input\n");
  return { appRoot, root };
}
