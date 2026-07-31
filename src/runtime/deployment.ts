import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson, projectPaths, projectStoragePaths, userRoots, type ProjectIdentity, type ProjectStoragePaths } from "./user-paths.js";
import { SetupFailure, type ArtifactEvidence, type ServerName, type ToolEvidence } from "../setup/types.js";
import { internalSetupTestHooks } from "../setup/test-hooks.js";

export type DeploymentMode = "local" | "shared";
export type ClientName = "codex" | "claude" | "opencode";
export const MINIMAL_PROJECT_CONTRACT = "minimal-v1" as const;
export type ProjectContract = typeof MINIMAL_PROJECT_CONTRACT;

export type DeploymentManifest = {
  schemaVersion: "3";
  setupVersion: string;
  createdAt: string;
  updatedAt: string;
  identity: ProjectIdentity;
  mode: DeploymentMode;
  clients: ClientName[];
  projectFiles: string[];
  tools: Partial<Record<ServerName, ToolEvidence>>;
  artifacts: Record<string, ArtifactEvidence>;
  /** Present only for genuinely new minimal project integrations. */
  projectContract?: ProjectContract;
};

export type LegacyDeploymentManifest = Omit<DeploymentManifest, "schemaVersion" | "tools" | "artifacts"> & {
  schemaVersion: "2";
};

export type RegistryRecord = {
  id: string;
  root: string;
  gitCommonDir: string;
  remote: string | null;
  mode: DeploymentMode;
  clients: ClientName[];
  updatedAt: string;
};

export type DeploymentRegistry = {
  schemaVersion: "1";
  revision: number;
  projects: Record<string, RegistryRecord>;
};

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function readRegistry(root?: string): DeploymentRegistry {
  const registryPath = root ? projectPaths(root).registry : path.join(userRoots().config, "registry.json");
  if (!fs.existsSync(registryPath)) return { schemaVersion: "1", revision: 0, projects: {} };
  let parsed: DeploymentRegistry;
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as DeploymentRegistry;
  } catch (error: any) {
    throw new SetupFailure(
      "registry",
      "SETUP_REGISTRY_UNREADABLE",
      `Deployment registry is unreadable: ${registryPath}`,
      "Restore or repair this file; setup will never replace an unreadable registry with an empty one.",
      { file: registryPath, cause: error?.message ?? String(error) },
    );
  }
  if (parsed.schemaVersion !== "1" || !parsed.projects || typeof parsed.projects !== "object") {
    throw new SetupFailure("registry", "SETUP_REGISTRY_UNREADABLE", `Deployment registry has an unsupported shape: ${registryPath}`, "Run hy-workflow doctor --json for recovery guidance.", { file: registryPath });
  }
  return { ...parsed, revision: Number.isInteger(parsed.revision) ? parsed.revision : 0 };
}

function readDeploymentFile(file: string): DeploymentManifest | LegacyDeploymentManifest | null {
  if (!fs.existsSync(file)) return null;
  let parsed: DeploymentManifest | LegacyDeploymentManifest;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf-8")); }
  catch (error: any) {
    throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", `Deployment manifest is unreadable: ${file}`, "Run hy-workflow doctor --json; do not delete external state until it has been reconciled.", { file, cause: error?.message ?? String(error) });
  }
  if (parsed?.schemaVersion === "3" || parsed?.schemaVersion === "2") return parsed;
  throw new SetupFailure(
    "transaction",
    "SETUP_TRANSACTION_FAILED",
    `Deployment manifest has an unsupported schema: ${file}`,
    "Run hy-workflow doctor --offline --json; setup will not reinterpret or delete unknown external state.",
    { file, schemaVersion: (parsed as any)?.schemaVersion },
  );
}

export function readDeployment(root: string): DeploymentManifest | LegacyDeploymentManifest | null {
  return readDeploymentFile(projectPaths(root).deployment);
}

export function readDeploymentById(projectId: string): DeploymentManifest | LegacyDeploymentManifest | null {
  return readDeploymentFile(projectStoragePaths(projectId).deployment);
}

export function writeDeployment(
  root: string,
  input: {
    setupVersion: string;
    mode: DeploymentMode;
    clients: ClientName[];
    projectFiles?: string[];
    tools?: Partial<Record<ServerName, ToolEvidence>>;
    artifacts?: Record<string, ArtifactEvidence>;
    projectContract?: ProjectContract;
  },
  beforeWrite?: (resource: "deployment" | "registry", value: DeploymentManifest | DeploymentRegistry) => void,
  afterWrite?: (resource: "deployment" | "registry") => void,
): DeploymentManifest {
  const paths = projectPaths(root);
  const previous = readDeployment(root);
  const now = new Date().toISOString();
  const manifest: DeploymentManifest = {
    schemaVersion: "3",
    setupVersion: input.setupVersion,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    identity: paths.identity,
    mode: input.mode,
    clients: [...new Set(input.clients)].sort() as ClientName[],
    projectFiles: [...new Set(input.projectFiles ?? [])].sort(),
    tools: input.tools ?? {},
    artifacts: input.artifacts ?? {},
    ...(input.projectContract ? { projectContract: input.projectContract } : {}),
  };
  beforeWrite?.("deployment", manifest);
  atomicWriteJson(paths.deployment, manifest);
  afterWrite?.("deployment");

  const registry = readRegistry(root);
  registry.projects[paths.identity.id] = {
    ...paths.identity,
    mode: manifest.mode,
    clients: manifest.clients,
    updatedAt: now,
  };
  registry.revision += 1;
  beforeWrite?.("registry", registry);
  atomicWriteJson(paths.registry, registry);
  afterWrite?.("registry");
  return manifest;
}

function assertOwnedDirectory(target: string, parent: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove path outside owned directory: ${target}`);
  }
}

type StagedDirectory = { target: string; tombstone: string };

export type UnregisterOutcome = {
  removed: boolean;
  remaining: number;
  manifest: DeploymentManifest | LegacyDeploymentManifest | null;
  paths: ProjectStoragePaths;
  rollback(): void;
  finalize(): string[];
};

function restoreStaged(staged: StagedDirectory[]): string[] {
  const manual: string[] = [];
  for (const item of [...staged].reverse()) {
    if (!fs.existsSync(item.tombstone)) continue;
    if (fs.existsSync(item.target)) { manual.push(item.target); continue; }
    try { fs.renameSync(item.tombstone, item.target); }
    catch { manual.push(item.target); }
  }
  return manual;
}

export function unregisterProject(
  root: string,
  projectId?: string,
  beforeRegistryWrite?: (registry: DeploymentRegistry) => void,
  afterRegistryWrite?: () => void,
  directoryJournal?: {
    prepare(target: string, tombstone: string): void;
    staged(target: string, tombstone: string): void;
  },
  options: { preserveConfig?: boolean } = {},
): UnregisterOutcome {
  const paths = projectPaths(root);
  const registry = readRegistry(root);
  const id = projectId ?? paths.identity.id;
  const roots = userRoots();
  const target = projectStoragePaths(id, roots);
  const manifest = readDeploymentById(id);
  const directories = [
    ...(options.preserveConfig ? [] : [[target.configDir, path.join(roots.config, "projects")] as const]),
    [target.stateDir, path.join(roots.state, "projects")],
    [target.cacheDir, path.join(roots.cache, "projects")],
  ] as const;
  const removed = Boolean(registry.projects[id] || manifest || directories.some(([directory]) => fs.existsSync(directory)));
  const staged: StagedDirectory[] = [];
  try {
    for (const [directory, parent] of directories) {
      assertOwnedDirectory(directory, parent);
      if (!fs.existsSync(directory)) continue;
      const tombstone = `${directory}.removing-${randomUUID()}`;
      directoryJournal?.prepare(directory, tombstone);
      fs.renameSync(directory, tombstone);
      directoryJournal?.staged(directory, tombstone);
      internalSetupTestHooks().afterDirectoryStage?.(directory);
      staged.push({ target: directory, tombstone });
    }
    delete registry.projects[id];
    registry.revision += 1;
    beforeRegistryWrite?.(registry);
    atomicWriteJson(paths.registry, registry);
    afterRegistryWrite?.();
  } catch (error) {
    const manual = restoreStaged(staged);
    if (manual.length) {
      throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", "Unset failed and external project state could not be restored atomically.", "Run hy-workflow doctor --offline --json; staged directories were preserved.", { manual, cause: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
  let settled = false;
  return {
    removed,
    remaining: Object.keys(registry.projects).length,
    manifest,
    paths: target,
    rollback() {
      if (settled) return;
      const manual = restoreStaged(staged);
      if (manual.length) throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", "Unset rollback found conflicting external project state.", "Run hy-workflow doctor --offline --json; staged directories were preserved.", { manual });
      settled = true;
    },
    finalize() {
      if (settled) return [];
      const remaining: string[] = [];
      for (const item of staged) {
        try { fs.rmSync(item.tombstone, { recursive: true, force: true }); }
        catch { remaining.push(item.tombstone); }
        if (fs.existsSync(item.tombstone) && !remaining.includes(item.tombstone)) remaining.push(item.tombstone);
      }
      settled = true;
      return remaining;
    },
  };
}

export function registeredProjectCount(root?: string): number {
  return Object.keys(readRegistry(root).projects).length;
}
