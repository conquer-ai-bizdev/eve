import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";

type PrewarmAppSandboxesInput = Parameters<typeof prewarmAppSandboxes>[0];
type VercelBuildPrewarmInput = PrewarmAppSandboxesInput & {
  readonly outputDir: string;
};

export const VERCEL_SANDBOX_TEMPLATE_MANIFEST_PATH = join(
  "static",
  ".well-known",
  "eve",
  "sandbox-templates.json",
);

const VERCEL_BUILD_PREWARM_SKIPPED_WARNING =
  "[eve] WARNING: Skipped Vercel sandbox template prewarm because VERCEL_DEPLOYMENT_ID is missing. " +
  "The generated .vercel/output may reference sandbox templates that were not provisioned. " +
  'Do not deploy it with "vercel deploy --prebuilt"; use "vercel deploy" so Vercel builds from source.';

/**
 * Detects whether the current build is running inside Vercel with a
 * stable deployment identifier. Build-time sandbox prewarm runs only
 * when this returns true so dev runs and one-off builds don't try to
 * provision templates against the platform.
 */
export function shouldPrewarmVercelBuild(): boolean {
  const vercel = process.env.VERCEL?.trim();
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();

  return (
    typeof vercel === "string" &&
    vercel.length > 0 &&
    typeof deploymentId === "string" &&
    deploymentId.length > 0
  );
}

/**
 * Vercel build-time sandbox prewarm hook. Failures here are treated as
 * build failures because the same sandbox bootstrap would otherwise
 * break at runtime.
 *
 * Returns `true` when the prewarm ran, `false` when the current
 * environment is not a Vercel build.
 */
export async function runVercelBuildPrewarm(input: VercelBuildPrewarmInput): Promise<boolean> {
  if (!shouldPrewarmVercelBuild()) {
    if (process.env.VERCEL?.trim() && !process.env.VERCEL_DEPLOYMENT_ID?.trim()) {
      console.warn(VERCEL_BUILD_PREWARM_SKIPPED_WARNING);
    }
    return false;
  }
  let templateKeys: readonly string[] = [];
  await prewarmAppSandboxes({
    ...input,
    onTemplateKeys(keys) {
      templateKeys = keys;
      input.onTemplateKeys?.(keys);
    },
  });
  const manifestPath = join(input.outputDir, VERCEL_SANDBOX_TEMPLATE_MANIFEST_PATH);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        deploymentId: process.env.VERCEL_DEPLOYMENT_ID,
        kind: "eve-sandbox-template-manifest",
        templateKeys: [...templateKeys].sort(),
        version: 1,
      },
      null,
      2,
    )}\n`,
  );
  return true;
}
