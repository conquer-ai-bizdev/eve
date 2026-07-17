import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { attachAgentBehaviorRevisions } from "#compiler/agent-behavior-revision.js";
import { compileAgent } from "#compiler/compile-agent.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { useScenarioApp, type ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();

const ROOT_INSTRUCTIONS = "Handle the request precisely.\n";
const SKILL_MARKDOWN = [
  "---",
  "description: Research a topic before answering.",
  "---",
  "",
  "Read the available sources before answering.",
  "",
].join("\n");
const SKILL_SCRIPT = "#!/bin/sh\necho research\n";
const RAW_ASSET = "baseline asset\n";
const LOCKFILE = "lockfileVersion: '9.0'\nsettings: {}\nimporters: {}\n";
const UNRELATED_SOURCE = "This file is not an agent input.\n";
const TOOL_HELPER = [
  "export function transform(value) {",
  '  return { ...value, source: "baseline" };',
  "}",
  "",
].join("\n");
const TOOL_MODULE = [
  'import { transform } from "../lib/tool-helper.mjs";',
  'import { externalValue } from "external-only/subpath";',
  'import rawAsset from "../assets/tool-note.txt?raw";',
  "",
  "export default {",
  '  description: "Transform one value.",',
  '  inputSchema: { type: "object", properties: { value: { type: "string" } } },',
  "  async execute(input) {",
  "    return transform(externalValue({ ...input, rawAsset }));",
  "  },",
  "};",
  "",
].join("\n");
const SHARED_CONFIG = 'export const MODEL_ID = "openai/gpt-5.4";\n';
const CHILD_INSTRUCTIONS = "Review the request independently.\n";
const GRANDCHILD_INSTRUCTIONS = "Critique the review independently.\n";

function descriptor(): ScenarioAppDescriptor {
  return {
    name: "behavior-revision-matrix",
    files: {
      "agent/agent.mjs": [
        'import { MODEL_ID } from "./lib/shared-config.mjs";',
        'export default { build: { externalDependencies: ["external-only"] }, model: MODEL_ID };',
        "",
      ].join("\n"),
      "agent/assets/tool-note.txt": RAW_ASSET,
      "agent/instructions.md": ROOT_INSTRUCTIONS,
      "agent/lib/shared-config.mjs": SHARED_CONFIG,
      "agent/lib/tool-helper.mjs": TOOL_HELPER,
      "agent/skills/research/SKILL.md": SKILL_MARKDOWN,
      "agent/skills/research/scripts/research.sh": SKILL_SCRIPT,
      "agent/subagents/reviewer/agent.mjs": [
        'import { MODEL_ID } from "../../lib/shared-config.mjs";',
        'export default { model: MODEL_ID, description: "Review one result." };',
        "",
      ].join("\n"),
      "agent/subagents/reviewer/instructions.md": CHILD_INSTRUCTIONS,
      "agent/subagents/reviewer/subagents/critic/agent.mjs": [
        'export default { model: "openai/gpt-5.4", description: "Critique one review." };',
        "",
      ].join("\n"),
      "agent/subagents/reviewer/subagents/critic/instructions.md": GRANDCHILD_INSTRUCTIONS,
      "agent/subagents/reviewer/tools/review.mjs": [
        "export default {",
        '  description: "Review one result.",',
        '  inputSchema: { type: "object" },',
        "  async execute(input) { return input; },",
        "};",
        "",
      ].join("\n"),
      "agent/tools/transform.mjs": TOOL_MODULE,
      "node_modules/external-only/package.json": [
        '{ "name": "external-only", "type": "module", "version": "1.0.0" }',
        "",
      ].join("\n"),
      "node_modules/external-only/subpath.js": [
        "export function externalValue(value) { return value; }",
        "",
      ].join("\n"),
      "pnpm-lock.yaml": LOCKFILE,
      "unrelated.txt": UNRELATED_SOURCE,
    },
  };
}

describe("agent behavior revisions", () => {
  it("covers behavior inputs per node without depending on checkout paths", async () => {
    const first = await scenarioApp(descriptor());
    const second = await scenarioApp(descriptor());
    const baselineManifest = await compileAgent({ startPath: first.appRoot }).then(
      (result) => result.manifest,
    );
    const baseline = revisions(baselineManifest);
    const relocated = revisions(
      await compileAgent({ startPath: second.appRoot }).then((r) => r.manifest),
    );

    expect(relocated).toEqual(baseline);
    const nextEveVersion = revisions(
      await attachAgentBehaviorRevisions({
        eveVersion: "0.22.6-test",
        manifest: baselineManifest,
      }),
    );
    expect(nextEveVersion.root).not.toBe(baseline.root);
    expect(nextEveVersion.reviewer).not.toBe(baseline.reviewer);
    expect(nextEveVersion.critic).not.toBe(baseline.critic);

    const packageJson = await readFile(join(first.appRoot, "package.json"), "utf8");
    const changedPackageJson = JSON.stringify(
      {
        ...(JSON.parse(packageJson) as Record<string, unknown>),
        devDependencies: { "unused-test-dependency": "1.0.0" },
      },
      null,
      2,
    );
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      changes: ["root", "reviewer", "critic"],
      path: "package.json",
      replacement: `${changedPackageJson}\n`,
      restore: packageJson,
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      changes: ["root", "reviewer", "critic"],
      path: "pnpm-lock.yaml",
      replacement: LOCKFILE.replace("settings: {}", "settings: { autoInstallPeers: false }"),
      restore: LOCKFILE,
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      changes: [],
      path: "unrelated.txt",
      replacement: "Changed but still unrelated.\n",
      restore: UNRELATED_SOURCE,
    });

    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      path: "agent/instructions.md",
      replacement: "Handle the request precisely and concisely.\n",
      changes: ["root"],
      restore: ROOT_INSTRUCTIONS,
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      path: "agent/skills/research/SKILL.md",
      replacement: SKILL_MARKDOWN.replace("available sources", "primary sources"),
      changes: ["root"],
      restore: SKILL_MARKDOWN,
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      path: "agent/skills/research/scripts/research.sh",
      replacement: "#!/bin/sh\necho deep-research\n",
      changes: ["root"],
      restore: SKILL_SCRIPT,
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      path: "agent/tools/transform.mjs",
      replacement: TOOL_MODULE.replace(
        'properties: { value: { type: "string" } }',
        'properties: { value: { type: "number" } }',
      ),
      changes: ["root"],
      restore: TOOL_MODULE,
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      path: "agent/tools/transform.mjs",
      replacement: TOOL_MODULE.replace(
        "return transform(externalValue({ ...input, rawAsset }));",
        "return transform(externalValue({ input, rawAsset }));",
      ),
      changes: ["root"],
      restore: TOOL_MODULE,
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      path: "agent/lib/tool-helper.mjs",
      replacement: TOOL_HELPER.replace('source: "baseline"', 'source: "changed"'),
      changes: ["root"],
      restore: TOOL_HELPER,
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      path: "agent/assets/tool-note.txt",
      replacement: "changed asset\n",
      changes: ["root"],
      restore: RAW_ASSET,
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      path: "agent/lib/shared-config.mjs",
      replacement: 'export const MODEL_ID = "anthropic/claude-sonnet-5";\n',
      changes: ["root", "reviewer"],
      restore: SHARED_CONFIG,
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      path: "agent/subagents/reviewer/instructions.md",
      replacement: "Review the request independently and skeptically.\n",
      changes: ["reviewer"],
      restore: CHILD_INSTRUCTIONS,
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      path: "agent/subagents/reviewer/agent.mjs",
      replacement: [
        'import { MODEL_ID } from "../../lib/shared-config.mjs";',
        'export default { model: MODEL_ID, description: "Review one result carefully." };',
        "",
      ].join("\n"),
      changes: ["root", "reviewer"],
      restore: [
        'import { MODEL_ID } from "../../lib/shared-config.mjs";',
        'export default { model: MODEL_ID, description: "Review one result." };',
        "",
      ].join("\n"),
    });
    await assertMutation({
      appRoot: first.appRoot,
      baseline,
      path: "agent/subagents/reviewer/subagents/critic/instructions.md",
      replacement: "Critique the review independently and skeptically.\n",
      changes: ["critic"],
      restore: GRANDCHILD_INSTRUCTIONS,
    });
  }, 120_000);
});

async function assertMutation(input: {
  readonly appRoot: string;
  readonly baseline: RevisionSet;
  readonly changes: readonly (keyof RevisionSet)[];
  readonly path: string;
  readonly replacement: string;
  readonly restore: string;
}): Promise<void> {
  await writeFile(join(input.appRoot, input.path), input.replacement);
  const changed = revisions(
    await compileAgent({ startPath: input.appRoot }).then((result) => result.manifest),
  );
  await writeFile(join(input.appRoot, input.path), input.restore);

  for (const key of ["root", "reviewer", "critic"] as const) {
    if (input.changes.includes(key)) {
      expect(changed[key], `${input.path} should change ${key}`).not.toBe(input.baseline[key]);
    } else {
      expect(changed[key], `${input.path} should not change ${key}`).toBe(input.baseline[key]);
    }
  }
}

interface RevisionSet {
  readonly critic: string;
  readonly reviewer: string;
  readonly root: string;
}

function revisions(manifest: CompiledAgentManifest): RevisionSet {
  const reviewer = manifest.subagents.find((subagent) => subagent.name === "reviewer");
  const critic = manifest.subagents.find((subagent) => subagent.name === "critic");
  if (reviewer === undefined) {
    throw new Error("Expected reviewer subagent.");
  }
  if (critic === undefined) {
    throw new Error("Expected critic subagent.");
  }

  return {
    critic: critic.agent.behaviorRevision,
    reviewer: reviewer.agent.behaviorRevision,
    root: manifest.behaviorRevision,
  };
}
