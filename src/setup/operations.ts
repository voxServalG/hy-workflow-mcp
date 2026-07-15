import * as fs from "node:fs";
import { ensureConfigDefaults } from "../config.js";
import { readDeployment, readRegistry, unregisterProject, writeDeployment, type ClientName } from "../runtime/deployment.js";
import { atomicWriteJson, projectPaths } from "../runtime/user-paths.js";
import { SETUP_VERSION } from "../bootstrap.js";
import { createClaudeAdapter } from "./clients/claude.js";
import { createCodexAdapter } from "./clients/codex.js";
import { definitionEquals } from "./clients/index.js";
import { createOpenCodeAdapter } from "./clients/opencode.js";
import { SHARED_PROJECT_FILES, writeSharedArtifacts } from "./shared.js";
import { MCP_DEFINITIONS, type ClientAdapter, type ClientDetection, type ClientServerSnapshot, type McpDefinition, type ServerName, type SetupOptions, type SetupResult } from "./types.js";

type OwnershipEntry = {
  desired: McpDefinition;
  previous: ClientServerSnapshot | null;
};

type OwnershipManifest = {
  schemaVersion: "1";
  clients: Partial<Record<ClientName, Partial<Record<ServerName, OwnershipEntry>>>>;
};

export function createClientAdapters(): ClientAdapter[] {
  return [createCodexAdapter(), createClaudeAdapter(), createOpenCodeAdapter()];
}

export function detectClients(adapters = createClientAdapters()): ClientDetection[] {
  return adapters.map(adapter => {
    try { return adapter.detect(); }
    catch (error: any) {
      return { name: adapter.name, installed: false, executable: null, version: null, configured: [], error: error?.message ?? String(error) };
    }
  });
}

function readOwnership(root: string): OwnershipManifest {
  const file = projectPaths(root).clientOwnership;
  if (!fs.existsSync(file)) return { schemaVersion: "1", clients: {} };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf-8"));
    return value?.schemaVersion === "1" && value.clients ? value : { schemaVersion: "1", clients: {} };
  } catch {
    throw new Error(`Client ownership manifest is unreadable: ${file}`);
  }
}

function writeOwnership(root: string, ownership: OwnershipManifest): void {
  atomicWriteJson(projectPaths(root).clientOwnership, ownership);
}

function restoreLegacyConfig(file: string, parent: string, text: string): void {
  fs.mkdirSync(parent, { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, text, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function selectedAdapters(options: SetupOptions, adapters: ClientAdapter[]): ClientAdapter[] {
  const selected = new Set(options.clients);
  const result = adapters.filter(adapter => selected.has(adapter.name));
  const missing = options.clients.filter(name => !result.some(adapter => adapter.name === name));
  if (missing.length) throw new Error(`Unsupported clients: ${missing.join(", ")}`);
  return result;
}

function installClients(root: string, selected: ClientAdapter[], dryRun: boolean): SetupResult["clients"] {
  const ownership = readOwnership(root);
  const completed: Array<{ adapter: ClientAdapter; server: ServerName; previous: ClientServerSnapshot }> = [];
  const results: SetupResult["clients"] = [];
  try {
    for (const adapter of selected) {
      const detection = adapter.detect();
      if (!detection.installed) throw new Error(`${adapter.name} is not installed or not on PATH`);
      for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
        const desired = MCP_DEFINITIONS[server];
        const previous = adapter.inspect(server);
        if (!dryRun) {
          const installedPrevious = adapter.install(server, desired);
          completed.push({ adapter, server, previous: installedPrevious });
          ownership.clients[adapter.name] ??= {};
          ownership.clients[adapter.name]![server] ??= { desired, previous: installedPrevious };
        }
        results.push({ name: adapter.name, status: previous.definition ? "kept" : "configured", detail: server });
      }
    }
  } catch (error) {
    for (const item of completed.reverse()) {
      try { item.adapter.remove(item.server, MCP_DEFINITIONS[item.server], item.previous); } catch {}
    }
    throw error;
  }
  if (!dryRun) writeOwnership(root, ownership);
  return results;
}

function removeClients(root: string, selected: ClientAdapter[], dryRun: boolean): SetupResult["clients"] {
  const ownership = readOwnership(root);
  const results: SetupResult["clients"] = [];
  const completed: Array<{ adapter: ClientAdapter; server: ServerName; desired: McpDefinition }> = [];
  try {
    for (const adapter of selected) {
      for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
        const entry = ownership.clients[adapter.name]?.[server];
        if (!entry) {
          results.push({ name: adapter.name, status: "skipped", detail: `${server}: not owned` });
          continue;
        }
        if (!dryRun) {
          const before = adapter.inspect(server);
          adapter.remove(server, entry.desired, entry.previous);
          if (definitionEquals(before.definition, entry.desired)) completed.push({ adapter, server, desired: entry.desired });
          delete ownership.clients[adapter.name]![server];
        }
        results.push({ name: adapter.name, status: "removed", detail: server });
      }
      if (!dryRun && ownership.clients[adapter.name] && !Object.keys(ownership.clients[adapter.name]!).length) {
        delete ownership.clients[adapter.name];
      }
    }
  } catch (error) {
    for (const item of completed.reverse()) {
      try { item.adapter.install(item.server, item.desired); } catch {}
    }
    throw error;
  }
  if (!dryRun) writeOwnership(root, ownership);
  return results;
}

export async function executeSetup(root: string, options: SetupOptions, adapters = createClientAdapters()): Promise<SetupResult> {
  const paths = projectPaths(root);
  const selected = selectedAdapters(options, adapters);

  if (options.action === "unset") {
    const legacyConfig = fs.existsSync(paths.config) ? fs.readFileSync(paths.config, "utf-8") : null;
    const deployment = readDeployment(root);
    const registry = readRegistry(root);
    const remainingAfter = Math.max(0, Object.keys(registry.projects).length - (deployment ? 1 : 0));
    const clients = options.removeGlobal && remainingAfter === 0 ? removeClients(root, selected, options.dryRun) : [];
    const outcome = options.dryRun
      ? { removed: Boolean(deployment), remaining: remainingAfter }
      : unregisterProject(root);
    if (!options.dryRun && legacyConfig !== null) restoreLegacyConfig(paths.config, paths.configDir, legacyConfig);
    return {
      ok: true,
      action: "unset",
      mode: deployment?.mode ?? "shared",
      projectId: paths.identity.id,
      projectRoot: paths.identity.root,
      clients,
      projectFilesChanged: [],
      localFilesChanged: [paths.configDir, paths.stateDir, paths.cacheDir],
      remainingProjects: outcome.remaining,
      dryRun: options.dryRun,
      message: "Local deployment removed; shared project files kept",
    };
  }

  const configResult = ensureConfigDefaults(root, { dryRun: true });
  if (!configResult.ok || !configResult.candidate) throw new Error(configResult.display.body);
  const config = configResult.candidate;
  const clients = installClients(root, selected, options.dryRun);
  const projectFilesChanged = writeSharedArtifacts(root, config, options.dryRun);
  if (!options.dryRun) {
    writeDeployment(root, {
      setupVersion: SETUP_VERSION,
      mode: "shared",
      clients: options.clients,
      projectFiles: [...SHARED_PROJECT_FILES],
    });
  }
  return {
    ok: true,
    action: "setup",
    mode: "shared",
    projectId: paths.identity.id,
    projectRoot: paths.identity.root,
    clients,
    projectFilesChanged,
    localFilesChanged: [paths.deployment, paths.registry, paths.clientOwnership],
    dryRun: options.dryRun,
    message: projectFilesChanged.length ? `Shared project files changed: ${projectFilesChanged.join(", ")}` : "Shared project files already current",
  };
}
