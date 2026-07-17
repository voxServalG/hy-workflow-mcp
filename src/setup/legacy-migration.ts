import fs from "node:fs";
import path from "node:path";
import type { ClientAdapter, McpDefinition, ServerName } from "./types.js";
import type { ClientName } from "../runtime/deployment.js";
import { MCP_DEFINITIONS } from "./types.js";

export type LegacyFinding = {
  source: string;
  server: ServerName;
  client: ClientName;
  existing: unknown;
};

const MCP_JSON = ".mcp.json";
const OPENCODE_PROJECT = path.join(".opencode", "opencode.json");
const CODEX_PROJECT = path.join(".codex", "config.toml");

function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJson(p: string): unknown | null {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * Scan project root for legacy client-local MCP definitions that would shadow or
 * conflict with setup's user-scope writes. Only hy-workflow/docs-gardener
 * entries are reported; unrelated custom servers are left untouched.
 */
export function scanLegacyClientConfigs(root: string): LegacyFinding[] {
  const findings: LegacyFinding[] = [];

  // .mcp.json — generic legacy format { mcpServers: { name: {...} } }
  const mcpJsonPath = path.join(root, MCP_JSON);
  if (exists(mcpJsonPath)) {
    const parsed = readJson(mcpJsonPath);
    const servers = (parsed as any)?.mcpServers;
    if (servers && typeof servers === "object") {
      for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
        if (servers[server]) findings.push({ source: MCP_JSON, server, client: "opencode" as ClientName, existing: servers[server] });
      }
    }
  }

  // .opencode/opencode.json — opencode project config { mcp: { name: {...} } }
  const opencodePath = path.join(root, OPENCODE_PROJECT);
  if (exists(opencodePath)) {
    const parsed = readJson(opencodePath);
    const servers = (parsed as any)?.mcp;
    if (servers && typeof servers === "object") {
      for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
        if (servers[server]) findings.push({ source: OPENCODE_PROJECT, server, client: "opencode" as ClientName, existing: servers[server] });
      }
    }
  }

  // .codex/config.toml — check for [mcp_servers.hy-workflow] / [mcp_servers.docs-gardener]
  const codexPath = path.join(root, CODEX_PROJECT);
  if (exists(codexPath)) {
    const text = fs.readFileSync(codexPath, "utf8");
    for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
      const re = new RegExp(`^\\s*\\[\\s*mcp_servers\\.${server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\]`, "m");
      if (re.test(text)) findings.push({ source: CODEX_PROJECT, server, client: "codex" as ClientName, existing: "[mcp_servers] section" });
    }
  }

  // .claude/ — Claude Code project settings live under .claude/ and are JSON; we only
  // flag if there is a managed-server entry for our servers. We do not parse here;
  // presence of .claude/ with our server is detected by the codex/claude adapter
  // via client_shadowed. For migration purposes any .claude directory containing a
  // settings*.json referencing our servers counts as a legacy source, but in
  // practice Claude writes project config as .mcp.json which we already covered.

  return findings;
}

/**
 * Back up legacy project-level client files to `.hy-cleanup-backup/<timestamp>/`
 * and ensure any hy-workflow/docs-gardener definition reported in the findings is
 * installed at user scope via the adapter. Legacy files are moved (not copied)
 * so shadowing disappears on the next run.
 */
export function migrateLegacyClientConfigs(
  root: string,
  adapters: ClientAdapter[],
  serversToMigrate: ServerName[] = ["hy-workflow", "docs-gardener"],
): { backupDir: string; moved: string[]; installedUserScope: ServerName[] } {
  const findings = scanLegacyClientConfigs(root);
  const bySource = new Map<string, LegacyFinding[]>();
  for (const f of findings) {
    if (!serversToMigrate.includes(f.server)) continue;
    const arr = bySource.get(f.source) ?? [];
    arr.push(f);
    bySource.set(f.source, arr);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(root, ".hy-cleanup-backup", stamp);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const moved: string[] = [];
  for (const [source] of bySource) {
    const abs = path.join(root, source);
    if (!exists(abs)) continue;
    const target = path.join(backupDir, source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(abs, target);
    moved.push(source);
  }

  // After moving project-level files out of the way, ensure any MCP server that was
  // previously defined only at project scope (and therefore absent from user scope)
  // gets written to user scope through the adapter.
  const installedUserScope: ServerName[] = [];
  for (const server of serversToMigrate) {
    for (const adapter of adapters) {
      try {
        const existing = adapter.inspect(server);
        const desired: McpDefinition = MCP_DEFINITIONS[server];
        if (existing.scope === "user" && existing.state === "active" && existing.definition
          && existing.definition.command === desired.command
          && JSON.stringify(existing.definition.args ?? []) === JSON.stringify(desired.args)) {
          continue;
        }
        adapter.install(server, desired);
        installedUserScope.push(server);
      } catch {
        // adapter missing or install failed; ignore — user can rerun setup normally
      }
    }
  }

  return { backupDir, moved, installedUserScope };
}

export function legacyClientOptions(): never {
  throw new Error("legacyClientOptions is deprecated");
}
