import type { ClientAdapter, ServerName } from "./types.js";
import type { ClientName } from "../runtime/deployment.js";

/** Compatibility-only public shape. Legacy repository injections are inert. */
export type LegacyFinding = {
  source: string;
  server: ServerName;
  client: ClientName;
  existing: unknown;
};

/**
 * Kept for callers compiled against the older setup API. The seamless-upgrade
 * contract forbids scanning historical repository injections.
 */
export function scanLegacyClientConfigs(_root: string): LegacyFinding[] {
  return [];
}

/**
 * Kept as a no-op during the deprecation window. Setup never copies, moves,
 * deletes, or interprets historical project-local client files.
 */
export function migrateLegacyClientConfigs(
  _root: string,
  _adapters: ClientAdapter[],
  _serversToMigrate: ServerName[] = ["hy-workflow", "docs-gardener"],
): { backupDir: string; moved: string[]; installedUserScope: ServerName[] } {
  return { backupDir: "", moved: [], installedUserScope: [] };
}

export function legacyClientOptions(): never {
  throw new Error("Legacy project injection migration has been retired; existing files are left untouched and ignored.");
}
