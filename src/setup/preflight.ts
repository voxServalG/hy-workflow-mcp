import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { COMMAND_NAMES } from "../commands/catalog.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import { MINIMAL_PROJECT_CONTRACT, readDeployment } from "../runtime/deployment.js";
import { executableInvocation, resolveExecutable, runExecutable } from "./clients/index.js";
import { assertSafeEffectiveConfig } from "./clients/effective.js";
import { assertSharedArtifactTarget, contentEvidence, renderWorkflowTemplate, SHARED_PROJECT_FILES, sharedArtifactPlan } from "./shared.js";
import {
  MCP_DEFINITIONS,
  SetupFailure,
  type ArtifactChange,
  type ClientAdapter,
  type ClientServerSnapshot,
  type ServerName,
  type SetupOptions,
  type ToolEvidence,
} from "./types.js";
import { internalSetupTestHooks } from "./test-hooks.js";

export type SetupPreflight = {
  tools: Partial<Record<ServerName, ToolEvidence>>;
  snapshots: Partial<Record<string, Partial<Record<ServerName, ClientServerSnapshot>>>>;
  artifactChanges: ArtifactChange[];
  artifactBeforeHashes: Record<string, string | null>;
  artifactExpectedHashes: Record<string, string>;
  ciCandidates?: string[];
  ciConfirmationRequired?: boolean;
  managesProjectFiles: boolean;
  configPersistence: "project-source" | "external-full" | "preserve";
  projectFileDisposition: "fresh" | "managed" | "explicit-sync" | "external-only" | "legacy-inert";
};

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedDiff(file: string, before: string, after: string): string {
  if (before === after) return "";
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
  const removed = oldLines.slice(prefix, Math.min(oldEnd, prefix + 80)).map(line => `-${line}`);
  const added = newLines.slice(prefix, Math.min(newEnd, prefix + 80)).map(line => `+${line}`);
  const truncated = oldEnd - prefix > 80 || newEnd - prefix > 80 ? ["... diff truncated; hashes cover full content ..."] : [];
  return [`--- a/${file}`, `+++ b/${file}`, `@@ line ${prefix + 1} @@`, ...removed, ...added, ...truncated].join("\n").slice(0, 16_384);
}

export function previewArtifactChanges(root: string, config: any): ArtifactChange[] {
  return sharedArtifactPlan(root, config).map(item => {
    const target = path.join(root, item.file);
    const existed = fs.existsSync(target);
    const before = existed ? fs.readFileSync(target) : null;
    const beforeHash = before ? digest(before) : null;
    const afterHash = contentEvidence(item.content).sha256;
    const changeKind: ArtifactChange["changeKind"] = !existed
      ? "create"
      : "unmanaged_existing";
    return {
      file: item.file,
      changeKind,
      beforeHash,
      afterHash,
      diff: boundedDiff(item.file, before?.toString("utf-8") ?? "", item.content),
      requiresAcceptance: existed && beforeHash !== afterHash,
    };
  });
}

/**
 * Detect only whether one of the two new integration targets is occupied.
 * This deliberately uses metadata only: an orphan project artifact is never
 * opened, parsed, diffed, or hashed merely because setup was invoked.
 */
export function existingSharedProjectFiles(root: string): string[] {
  return SHARED_PROJECT_FILES.filter(file => {
    try {
      fs.lstatSync(path.join(root, file));
      return true;
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  });
}

function completeExplicitReview(options: SetupOptions, existingFiles: string[]): boolean {
  if (!options.syncProjectArtifacts || !options.acceptArtifactChanges || !options.reviewedArtifactChanges?.length) return false;
  const expected = [...existingFiles].sort();
  const reviewed = options.reviewedArtifactChanges;
  const files = reviewed.map(item => item.file).sort();
  return JSON.stringify(files) === JSON.stringify(expected)
    && reviewed.every(item =>
      typeof item.beforeHash === "string"
      && /^[a-f0-9]{64}$/.test(item.beforeHash)
      && /^[a-f0-9]{64}$/.test(item.afterHash)
    );
}

function freshArtifactChanges(config: any): ArtifactChange[] {
  const values = [
    { file: "hy-workflow.json", content: JSON.stringify(config, null, 2) + "\n" },
    { file: ".github/workflows/hy-workflow.yml", content: renderWorkflowTemplate() },
  ];
  return values.map(({ file, content }) => ({
    file,
    changeKind: "create",
    beforeHash: null,
    afterHash: contentEvidence(content).sha256,
    diff: boundedDiff(file, "", content),
    requiresAcceptance: false,
  }));
}

function environment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

const DOCS_GARDENER_REQUIRED_TOOLS = [
  "garden-fix",
  "garden-grow",
  "garden-polish",
  "garden-scan",
  "garden-scan-hard",
  "garden-scan-soft",
] as const;

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonicalJson((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function validateToolCatalog(server: ServerName, tools: Array<{ name: string; inputSchema?: unknown }>): string {
  const names = tools.map(tool => tool.name).sort();
  if (new Set(names).size !== names.length) throw new Error(`${server} MCP catalog contains duplicate tool names`);
  if (server === "hy-workflow") {
    const expected = [...COMMAND_NAMES].sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error(`hy-workflow MCP catalog is incompatible: expected ${expected.join(",")}; got ${names.join(",")}`);
    }
  } else {
    const missing = DOCS_GARDENER_REQUIRED_TOOLS.filter(name => !names.includes(name));
    if (missing.length) throw new Error(`docs-gardener MCP catalog is missing required tools: ${missing.join(",")}`);
  }
  const contract = tools
    .map(tool => ({ name: tool.name, inputSchema: canonicalJson(tool.inputSchema ?? null) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return digest(JSON.stringify(contract));
}

async function handshake(root: string, server: ServerName, executable: string): Promise<string> {
  if (internalSetupTestHooks().skipHandshake) return "test-skip";
  const definition = MCP_DEFINITIONS[server];
  const invocation = executableInvocation(executable, definition.args);
  const transport = new StdioClientTransport({ command: invocation.command, args: invocation.args, cwd: root, env: environment(), stderr: "pipe" });
  const client = new Client({ name: "hy-workflow-setup", version: "1.0.0" }, { capabilities: {} });
  let timer: NodeJS.Timeout | undefined;
  try {
    const tools = await Promise.race([
      (async () => { await client.connect(transport); return (await client.listTools()).tools; })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("handshake timed out after 5000ms")), 5_000); }),
    ]);
    if (!tools.length) throw new Error("server returned zero tools");
    return validateToolCatalog(server, tools);
  } finally {
    if (timer) clearTimeout(timer);
    try { await client.close(); } catch {}
  }
}

export async function inspectSetupTools(root: string): Promise<Partial<Record<ServerName, ToolEvidence>>> {
  const result: Partial<Record<ServerName, ToolEvidence>> = {};
  for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
    const command = MCP_DEFINITIONS[server].command;
    const executable = resolveExecutable(command);
    if (!executable) {
      throw new SetupFailure(
        "binary_missing",
        "SETUP_BINARY_MISSING",
        `Required command is not installed or not on PATH: ${command}`,
        "Install both @voxstudio/hy-workflow and @voxstudio/docs-gardener globally, then rerun setup.",
        { server, command },
      );
    }
    const versionResult = runExecutable(executable, ["--version"], 5_000);
    if (!versionResult.ok || !versionResult.stdout) {
      throw new SetupFailure("preflight", "SETUP_PREFLIGHT_FAILED", `${command} --version failed.`, "Repair the global npm installation and rerun setup.", { command, executable, stderr: versionResult.stderr });
    }
    const version = versionResult.stdout.split(/\r?\n/)[0].trim();
    let catalogHash: string;
    try { catalogHash = await handshake(root, server, executable); }
    catch (error: any) {
      throw new SetupFailure("handshake", "SETUP_HANDSHAKE_FAILED", `${server} MCP stdio handshake failed: ${error?.message ?? String(error)}`, "Run hy-workflow doctor --offline --json and verify that the direct binary starts without npm or GitHub access.", { server, executable });
    }
    if (server === "hy-workflow" && !internalSetupTestHooks().skipHandshake && version !== PACKAGE_VERSION) {
      throw new SetupFailure(
        "preflight",
        "SETUP_BINARY_VERSION_MISMATCH",
        `hy-workflow on PATH is ${version}; this setup runtime is ${PACKAGE_VERSION}.`,
        "Update @voxstudio/hy-workflow globally and rerun setup from the same installation.",
        { server, executable, liveVersion: version, expectedVersion: PACKAGE_VERSION },
      );
    }
    result[server] = { command, executable, version, catalogHash };
  }
  return result;
}

export async function runSetupPreflight(
  root: string,
  options: SetupOptions,
  selected: ClientAdapter[],
  config: any,
  inspectDirectTools = true,
): Promise<SetupPreflight> {
  const snapshots: SetupPreflight["snapshots"] = {};
  for (const adapter of selected) {
    const detection = adapter.detect();
    if (!detection.installed && options.action === "setup") {
      throw new SetupFailure("client_missing", "SETUP_CLIENT_NOT_INSTALLED", `${adapter.name} is not installed or not on PATH.`, "Install the selected client, or rerun setup with a different explicit --clients list.", { client: adapter.name });
    }
    snapshots[adapter.name] = {};
    for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
      const value = adapter.inspect(server);
      snapshots[adapter.name]![server] = value;
      if (options.action === "setup") assertSafeEffectiveConfig(adapter.name, server, value, MCP_DEFINITIONS[server]);
    }
  }
  const deployment = readDeployment(root);
  const existingFiles = options.action === "setup" && !deployment
    ? existingSharedProjectFiles(root)
    : [];
  const explicitReviewRequested = options.syncProjectArtifacts === true;
  const explicitSync = options.action === "setup"
    && !deployment
    && existingFiles.length > 0
    && completeExplicitReview(options, existingFiles);
  if (options.action === "setup" && !deployment && existingFiles.length > 0 && explicitReviewRequested && !explicitSync) {
    throw new SetupFailure(
      "artifact_drift",
      "SETUP_ARTIFACT_REVIEW_INCOMPLETE",
      "Explicit project artifact sync requires its intent flag, acceptance, and one exact reviewed hash tuple for every occupied integration target.",
      "Supply --sync-project-artifacts, --accept-artifact-changes, and one --review-artifact tuple for each listed file. Ordinary setup leaves these files untouched and uses external configuration.",
      { files: [...existingFiles].sort(), reviewedFiles: (options.reviewedArtifactChanges ?? []).map(item => item.file).sort() },
    );
  }
  const minimalDeployment = Boolean(
    deployment?.schemaVersion === "3"
    && deployment.projectContract === MINIMAL_PROJECT_CONTRACT
  );
  const fresh = options.action === "setup" && !deployment && existingFiles.length === 0;
  if (fresh) for (const file of SHARED_PROJECT_FILES) assertSharedArtifactTarget(root, file);
  const managesProjectFiles = options.action === "setup" && (minimalDeployment || fresh || explicitSync);
  const projectFileDisposition: SetupPreflight["projectFileDisposition"] = options.action !== "setup"
    ? "legacy-inert"
    : minimalDeployment
      ? "managed"
      : explicitSync
        ? "explicit-sync"
        : fresh
          ? "fresh"
          : deployment
            ? "legacy-inert"
            : "external-only";
  const configPersistence: SetupPreflight["configPersistence"] = managesProjectFiles
    ? "project-source"
    : projectFileDisposition === "external-only"
      ? "external-full"
      : "preserve";
  const changes = managesProjectFiles
    ? fresh
      ? freshArtifactChanges(config)
      : previewArtifactChanges(root, config)
    : [];
  const artifactExpectedHashes: Record<string, string> = managesProjectFiles ? {
    "hy-workflow.json": digest(JSON.stringify(config, null, 2) + "\n"),
    ".github/workflows/hy-workflow.yml": digest(renderWorkflowTemplate()),
  } : {};
  const artifactBeforeHashes = fresh
    ? Object.fromEntries(SHARED_PROJECT_FILES.map(file => [file, null]))
    : Object.fromEntries((managesProjectFiles ? SHARED_PROJECT_FILES : []).map(file => {
        const target = path.join(root, file);
        return [file, fs.existsSync(target) ? digest(fs.readFileSync(target)) : null];
      }));
  for (const file of SHARED_PROJECT_FILES) {
    if (!managesProjectFiles) break;
    const baseline = artifactBeforeHashes[file];
    const expected = artifactExpectedHashes[file];
    const planned = changes.find(item => item.file === file);
    const stable = baseline === expected ? !planned : planned?.beforeHash === baseline && planned.afterHash === expected;
    if (!stable) {
      throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", `Shared artifact changed while locked preflight was sampling it: ${file}`, "Review the external edit and rerun setup; no write was attempted.", { file, baseline, expected, planned }, true);
    }
  }
  const blocked = changes.filter(item => item.requiresAcceptance);
  if (managesProjectFiles && (!options.dryRun || explicitSync)) {
    const reviewed = [...(options.reviewedArtifactChanges ?? [])].sort((left, right) => left.file.localeCompare(right.file));
    const requiredReview = (explicitSync
      ? existingFiles.map(file => ({
          file,
          beforeHash: artifactBeforeHashes[file],
          afterHash: artifactExpectedHashes[file],
        }))
      : blocked.map(({ file, beforeHash, afterHash }) => ({ file, beforeHash, afterHash })))
      .sort((left, right) => left.file.localeCompare(right.file));
    const reviewMatches = JSON.stringify(reviewed) === JSON.stringify(requiredReview);
    if ((blocked.length || reviewed.length) && (!options.acceptArtifactChanges || !reviewMatches)) {
      throw new SetupFailure(
        "artifact_drift",
        "SETUP_ARTIFACT_DRIFT",
        blocked.length
          ? `Setup would overwrite team artifacts whose exact hashes were not reviewed: ${blocked.map(item => item.file).join(", ")}`
          : "The accepted artifact review is stale; the reviewed files no longer require the displayed changes.",
        "Review the current diff again and accept its exact before/after hashes. A bare acceptance boolean is not reusable.",
        { changes: blocked, reviewed },
      );
    }
  }
  return {
    tools: inspectDirectTools && options.action === "setup" ? await inspectSetupTools(root) : {},
    snapshots,
    artifactChanges: changes,
    artifactBeforeHashes,
    artifactExpectedHashes,
    managesProjectFiles,
    configPersistence,
    projectFileDisposition,
  };
}
