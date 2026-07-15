import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteJson, projectPaths, userRoots, type ProjectIdentity } from "./user-paths.js";

export type DeploymentMode = "local" | "shared";
export type ClientName = "codex" | "claude" | "opencode";

export type DeploymentManifest = {
  schemaVersion: "2";
  setupVersion: string;
  createdAt: string;
  updatedAt: string;
  identity: ProjectIdentity;
  mode: DeploymentMode;
  clients: ClientName[];
  projectFiles: string[];
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
  const parsed = readJson<DeploymentRegistry>(registryPath);
  if (!parsed || parsed.schemaVersion !== "1" || !parsed.projects || typeof parsed.projects !== "object") {
    return { schemaVersion: "1", projects: {} };
  }
  return parsed;
}

export function readDeployment(root: string): DeploymentManifest | null {
  const parsed = readJson<DeploymentManifest>(projectPaths(root).deployment);
  return parsed?.schemaVersion === "2" ? parsed : null;
}

export function writeDeployment(
  root: string,
  input: { setupVersion: string; mode: DeploymentMode; clients: ClientName[]; projectFiles?: string[] },
): DeploymentManifest {
  const paths = projectPaths(root);
  const previous = readDeployment(root);
  const now = new Date().toISOString();
  const manifest: DeploymentManifest = {
    schemaVersion: "2",
    setupVersion: input.setupVersion,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    identity: paths.identity,
    mode: input.mode,
    clients: [...new Set(input.clients)].sort() as ClientName[],
    projectFiles: [...new Set(input.projectFiles ?? [])].sort(),
  };
  atomicWriteJson(paths.deployment, manifest);

  const registry = readRegistry(root);
  registry.projects[paths.identity.id] = {
    ...paths.identity,
    mode: manifest.mode,
    clients: manifest.clients,
    updatedAt: now,
  };
  atomicWriteJson(paths.registry, registry);
  return manifest;
}

function guardedRemove(target: string, parent: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove path outside owned directory: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

export function unregisterProject(root: string): { removed: boolean; remaining: number; manifest: DeploymentManifest | null } {
  const paths = projectPaths(root);
  const manifest = readDeployment(root);
  const registry = readRegistry(root);
  const removed = Boolean(registry.projects[paths.identity.id] || manifest);
  delete registry.projects[paths.identity.id];
  atomicWriteJson(paths.registry, registry);

  const roots = userRoots();
  guardedRemove(paths.configDir, path.join(roots.config, "projects"));
  guardedRemove(paths.stateDir, path.join(roots.state, "projects"));
  guardedRemove(paths.cacheDir, path.join(roots.cache, "projects"));
  return { removed, remaining: Object.keys(registry.projects).length, manifest };
}

export function registeredProjectCount(root?: string): number {
  return Object.keys(readRegistry(root).projects).length;
}
