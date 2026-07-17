import { createHash } from "node:crypto";
import { join } from "node:path";

import type {
  CompiledAgentManifest,
  CompiledAgentNodeManifest,
  CompiledExtensionMount,
  CompiledSkillDefinition,
  CompiledSubagentNode,
} from "#compiler/manifest.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { collectModuleRefsForManifest } from "#compiler/module-map.js";
import { createDependencyEnvironmentDigest } from "#compiler/dependency-environment.js";
import { bundleAuthoredModuleCode } from "#internal/authored-module-loader.js";

/** Version of the bytes-to-digest contract used for agent behavior revisions. */
export const AGENT_BEHAVIOR_REVISION_FORMAT_VERSION = 2;

interface DirectSubagentDescriptor {
  readonly description: string;
  readonly logicalPath: string;
  readonly name: string;
  readonly nodeId: string;
  readonly sourceId: string;
  readonly sourceKind: "module";
}

interface NodeRevisionInput {
  readonly dependencyEnvironmentDigest: string;
  readonly directSubagents: readonly DirectSubagentDescriptor[];
  readonly eveVersion: string;
  readonly manifest: CompiledAgentNodeManifest;
  readonly moduleManifest: CompiledAgentNodeManifest;
  readonly extensionMounts: readonly CompiledExtensionMount[];
}

/**
 * Attaches one compiler-owned behavior revision to every local agent graph node.
 *
 * Each revision is independent of checkout paths and sibling-node internals. It
 * covers the normalized node definition, materialized workspace/skill bytes,
 * direct delegation descriptors, bundled authored code for that node, and the
 * app's shared package-manager dependency environment.
 */
export async function attachAgentBehaviorRevisions(input: {
  readonly eveVersion: string;
  readonly manifest: CompiledAgentManifest;
}): Promise<CompiledAgentManifest> {
  const dependencyEnvironmentDigest = await createDependencyEnvironmentDigest(
    input.manifest.appRoot,
  );
  const directSubagentsByParent = indexDirectSubagents(input.manifest);
  const rootNodeManifest = omitGraphFields(input.manifest);
  const rootBehaviorRevision = await createAgentBehaviorRevision({
    dependencyEnvironmentDigest,
    directSubagents: directSubagentsByParent.get(ROOT_COMPILED_AGENT_NODE_ID) ?? [],
    eveVersion: input.eveVersion,
    extensionMounts: input.manifest.extensionMounts,
    manifest: rootNodeManifest,
    moduleManifest: input.manifest,
  });

  const subagents = await Promise.all(
    input.manifest.subagents.map(async (subagent) => ({
      ...subagent,
      agent: {
        ...subagent.agent,
        behaviorRevision: await createAgentBehaviorRevision({
          dependencyEnvironmentDigest,
          directSubagents: directSubagentsByParent.get(subagent.nodeId) ?? [],
          eveVersion: input.eveVersion,
          extensionMounts: [],
          manifest: subagent.agent,
          moduleManifest: subagent.agent,
        }),
      },
    })),
  );

  return {
    ...input.manifest,
    behaviorRevision: rootBehaviorRevision,
    subagents,
  };
}

async function createAgentBehaviorRevision(input: NodeRevisionInput): Promise<string> {
  const modules = await collectAuthoredModuleBundles(input);
  const hash = createHash("sha256");
  hash.update(`eve-agent-behavior-revision-v${AGENT_BEHAVIOR_REVISION_FORMAT_VERSION}\0`);
  updateHashPart(hash, "dependency-environment", input.dependencyEnvironmentDigest);
  updateHashPart(hash, "eve-version", input.eveVersion);
  updateHashPart(hash, "node", canonicalJson(createNodeBehaviorDefinition(input.manifest)));
  updateHashPart(
    hash,
    "workspace-resource-content",
    input.manifest.workspaceResourceRoot.contentHash ?? "",
  );
  updateHashPart(hash, "direct-subagents", canonicalJson(input.directSubagents));

  for (const module of modules) {
    updateHashPart(hash, "module-source-id", module.sourceId);
    updateHashPart(hash, "module-logical-path", module.logicalPath);
    updateHashPart(hash, "module-code", module.code);
  }

  return hash.digest("hex");
}

async function collectAuthoredModuleBundles(input: NodeRevisionInput): Promise<
  Array<{
    readonly code: string;
    readonly logicalPath: string;
    readonly sourceId: string;
  }>
> {
  const extensionScopeByMountNamespace = new Map(
    input.extensionMounts.map((mount) => [mount.namespace, mount.packageNamespace]),
  );
  const refs = collectModuleRefsForManifest(input.moduleManifest).sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  );
  const externalDependencies = input.manifest.config.build?.externalDependencies ?? [];

  return await Promise.all(
    refs.map(async (ref) => {
      const extensionScopeNamespace = resolveExtensionScopeNamespace(
        ref.sourceId,
        extensionScopeByMountNamespace,
      );
      const code = await bundleAuthoredModuleCode(
        join(input.manifest.agentRoot, ref.logicalPath),
        { externalDependencies, extensionScopeNamespace },
        { canonicalExternalSpecifiers: true, sourcemap: false },
      );

      return {
        code: canonicalizeAuthoredModuleBundle(code),
        logicalPath: ref.logicalPath,
        sourceId: ref.sourceId,
      };
    }),
  );
}

function createNodeBehaviorDefinition(manifest: CompiledAgentNodeManifest): unknown {
  const {
    agentRoot: _agentRoot,
    appRoot: _appRoot,
    behaviorRevision: _behaviorRevision,
    diagnosticsSummary: _diagnosticsSummary,
    workspaceResourceRoot: _workspaceResourceRoot,
    ...definition
  } = manifest;

  return {
    ...definition,
    remoteAgents: definition.remoteAgents.map(
      ({ entryPath: _entryPath, rootPath: _rootPath, ...remoteAgent }) => remoteAgent,
    ),
    sandboxWorkspaces: definition.sandboxWorkspaces.map(
      ({ sourcePath: _sourcePath, ...workspace }) => workspace,
    ),
    skills: definition.skills.map(stripSkillSourcePaths),
  };
}

function stripSkillSourcePaths(skill: CompiledSkillDefinition): unknown {
  if (skill.sourceKind !== "skill-package") {
    return skill;
  }

  const {
    assetsPath: _assetsPath,
    referencesPath: _referencesPath,
    rootPath: _rootPath,
    scriptsPath: _scriptsPath,
    skillFilePath: _skillFilePath,
    ...definition
  } = skill;
  return definition;
}

function indexDirectSubagents(
  manifest: CompiledAgentManifest,
): ReadonlyMap<string, readonly DirectSubagentDescriptor[]> {
  const subagentsByNodeId = new Map(
    manifest.subagents.map((subagent) => [subagent.nodeId, subagent]),
  );
  const byParent = new Map<string, DirectSubagentDescriptor[]>();

  for (const edge of manifest.subagentEdges) {
    const subagent = subagentsByNodeId.get(edge.childNodeId);
    if (subagent === undefined) {
      continue;
    }

    const descriptors = byParent.get(edge.parentNodeId) ?? [];
    descriptors.push(toDirectSubagentDescriptor(subagent));
    byParent.set(edge.parentNodeId, descriptors);
  }

  for (const descriptors of byParent.values()) {
    descriptors.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }
  return byParent;
}

function toDirectSubagentDescriptor(subagent: CompiledSubagentNode): DirectSubagentDescriptor {
  return {
    description: subagent.description,
    logicalPath: subagent.logicalPath,
    name: subagent.name,
    nodeId: subagent.nodeId,
    sourceId: subagent.sourceId,
    sourceKind: subagent.sourceKind,
  };
}

function resolveExtensionScopeNamespace(
  sourceId: string,
  byMountNamespace: ReadonlyMap<string, string>,
): string | undefined {
  const match = sourceId.match(/^ext:([^:]+):/);
  return match === null ? undefined : byMountNamespace.get(match[1]!);
}

function canonicalizeAuthoredModuleBundle(code: string): string {
  return code
    .split("\n")
    .filter((line) => !/^\s*\/\/#(?:end)?region(?:\s|$)/.test(line))
    .join("\n");
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

function updateHashPart(hash: ReturnType<typeof createHash>, label: string, value: string): void {
  hash.update(label);
  hash.update("\0");
  hash.update(String(Buffer.byteLength(value)));
  hash.update("\0");
  hash.update(value);
  hash.update("\0");
}

function omitGraphFields(manifest: CompiledAgentManifest): CompiledAgentNodeManifest {
  const {
    extensionMounts: _extensionMounts,
    kind: _kind,
    subagentEdges: _subagentEdges,
    subagents: _subagents,
    version: _version,
    ...node
  } = manifest;
  return node;
}
