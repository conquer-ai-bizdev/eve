import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  prewarmAppSandboxes: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
}));
vi.mock("#execution/sandbox/prewarm.js", () => ({
  prewarmAppSandboxes: mocks.prewarmAppSandboxes,
}));

import {
  runVercelBuildPrewarm,
  VERCEL_SANDBOX_TEMPLATE_MANIFEST_PATH,
} from "./vercel-build-prewarm.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("runVercelBuildPrewarm", () => {
  it("writes the exact successfully prewarmed template keys into Vercel build output", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_current");
    mocks.prewarmAppSandboxes.mockImplementation(async (input) => {
      input.onTemplateKeys?.([
        "eve-sbx-tpl-vercel-project-worker",
        "eve-sbx-tpl-vercel-project-root",
      ]);
    });
    const appRoot = "/app";
    const outputDir = "/output";

    await expect(runVercelBuildPrewarm({ appRoot, outputDir })).resolves.toBe(true);

    expect(mocks.mkdir).toHaveBeenCalledWith("/output/static/.well-known/eve", {
      recursive: true,
    });
    expect(mocks.writeFile).toHaveBeenCalledWith(
      `/output/${VERCEL_SANDBOX_TEMPLATE_MANIFEST_PATH}`,
      `${JSON.stringify(
        {
          deploymentId: "dpl_current",
          kind: "eve-sandbox-template-manifest",
          templateKeys: ["eve-sbx-tpl-vercel-project-root", "eve-sbx-tpl-vercel-project-worker"],
          version: 1,
        },
        null,
        2,
      )}\n`,
    );
  });
});
