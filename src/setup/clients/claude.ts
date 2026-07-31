import * as fs from "node:fs";
import * as path from "node:path";
import { SetupFailure, type ClientAdapter, type ClientConfigScope, type ClientDetection, type ClientServerSnapshot, type McpDefinition, type ServerName } from "../types.js";
import { assertClientSnapshotUnchanged } from "./effective.js";
import { definitionEquals, neutralCommandCwd, resolveExecutable, runExecutable, versionOf } from "./index.js";

export function parseClaudeGet(output: string): McpDefinition | null {
  const lines = output.split(/\r?\n/);
  const valueFor = (label: string): string | null => {
    const prefix = `${label.toLowerCase()}:`;
    const line = lines.find(item => item.trimStart().toLowerCase().startsWith(prefix));
    return line ? line.trimStart().slice(prefix.length).trim() : null;
  };
  const command = valueFor("Command");
  if (!command) return null;
  // Claude prints an empty `Args:` line immediately before `Environment:`.
  // Parsing line-by-line is intentional: a multiline regex can consume the next label.
  const argsText = valueFor("Args") ?? "";
  let args: string[] = [];
  if (argsText) {
    try {
      const parsed = JSON.parse(argsText);
      if (Array.isArray(parsed)) args = parsed.filter((item): item is string => typeof item === "string");
      else args = argsText.split(/\s+/).filter(Boolean);
    } catch {
      args = argsText.split(/\s+/).filter(Boolean);
    }
  }
  const environmentIndex = lines.findIndex(line => /^\s*Environment:\s*$/i.test(line));
  const env: Record<string, string> = {};
  if (environmentIndex >= 0) {
    for (let index = environmentIndex + 1; index < lines.length; index += 1) {
      const raw = lines[index];
      if (!raw.trim() || /^\s*(?:none|no environment variables)\s*$/i.test(raw)) continue;
      // Environment entries are indented. Current Claude Code appends an
      // unindented `To remove this server, run: ...` footer, which terminates
      // the block and must not be parsed as an environment variable.
      if (!/^\s+/.test(raw)) break;
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)\s*(.*)\s*$/.exec(raw);
      if (!match || /^(?:\*{3,}|<redacted>|redacted)$/i.test(match[2])) return null;
      env[match[1]] = match[2];
    }
  }
  return { command, args, ...(Object.keys(env).length ? { env } : {}) };
}

export function parseClaudeScope(output: string): ClientConfigScope {
  const scopeText = /^\s*Scope:\s*(.+?)\s*$/im.exec(output)?.[1]?.trim().toLowerCase() ?? "";
  // Claude commonly prints `User config (available in all your projects)`.
  // Match the scope label itself; searching for `project` would misclassify that
  // user-scoped value because the explanatory suffix contains `projects`.
  if (/^user\b/.test(scopeText)) return "user";
  if (/^(?:project|local)\b/.test(scopeText)) return "project";
  return "unknown";
}

function add(executable: string, server: ServerName, definition: McpDefinition, cwd: string): void {
  const env = Object.entries(definition.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const result = runExecutable(executable, ["mcp", "add", "-s", "user", ...env, server, "--", definition.command, ...definition.args], 15_000, { cwd });
  if (!result.ok) throw new Error(`claude mcp add ${server} failed: ${result.stderr || result.stdout}`);
}

function canonicalLocation(value: string): string {
  try { return fs.realpathSync(value); }
  catch {
    try { return path.join(fs.realpathSync(path.dirname(value)), path.basename(value)); }
    catch { return path.resolve(value); }
  }
}

function locationInside(root: string, target: string): boolean {
  const inside = (base: string, candidate: string): boolean => {
    const relative = path.relative(base, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  return inside(path.resolve(root), path.resolve(target)) || inside(canonicalLocation(root), canonicalLocation(target));
}

function unsafeClaudeStorage(root: string): { variable: string; value: string } | null {
  for (const variable of ["CLAUDE_CONFIG_DIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"] as const) {
    const value = process.env[variable];
    if (value && locationInside(root, value)) return { variable, value: path.resolve(value) };
  }
  return null;
}

export function createClaudeAdapter(root = process.env.HY_WORKFLOW_PROJECT_ROOT ?? process.cwd()): ClientAdapter {
  const executable = resolveExecutable("claude");
  const unsafeStorage = unsafeClaudeStorage(root);
  const commandCwd = neutralCommandCwd(root);
  const inspect = (server: ServerName): ClientServerSnapshot => {
    if (unsafeStorage) {
      return {
        definition: null,
        raw: { error: `${unsafeStorage.variable} points inside the project`, ...unsafeStorage },
        source: unsafeStorage.value,
        state: "unreadable",
        scope: "unknown",
      };
    }
    if (!executable) return { definition: null, state: "absent", scope: "user" };
    const result = runExecutable(executable, ["mcp", "get", server], 15_000, { cwd: commandCwd });
    if (!result.ok) {
      const diagnostic = `${result.stderr}\n${result.stdout}`.trim();
      if (/not found|does not exist|no mcp server|unknown mcp server/i.test(diagnostic)) return { definition: null, state: "absent", scope: "user" };
      return { definition: null, raw: { error: diagnostic || "claude mcp get failed" }, state: "unreadable", scope: "unknown" };
    }
    const definition = parseClaudeGet(result.stdout);
    const scope = parseClaudeScope(result.stdout);
    return {
      definition,
      raw: result.stdout,
      source: `claude:${scope}`,
      scope,
      enabled: true,
      state: scope === "unknown" || !definition ? "unreadable" : "active",
      sources: [{ scope, source: `claude:${scope}`, definition, enabled: true }],
      ownedDefinition: scope === "user" ? definition : null,
    };
  };
  const removeOnly = (server: ServerName): void => {
    if (!executable) throw new Error("claude is not installed");
    const result = runExecutable(executable, ["mcp", "remove", "-s", "user", server], 15_000, { cwd: commandCwd });
    if (!result.ok) throw new Error(`claude mcp remove ${server} failed: ${result.stderr || result.stdout}`);
  };
  return {
    name: "claude",
    detect(): ClientDetection {
      const configured = (["hy-workflow", "docs-gardener"] as ServerName[]).filter(server => Boolean(inspect(server).definition ?? inspect(server).raw));
      return { name: "claude", installed: Boolean(executable), executable, version: executable ? versionOf(executable, commandCwd) : null, configured };
    },
    inspect,
    install(server, definition, expectedPrevious) {
      if (!executable) throw new SetupFailure("client_missing", "SETUP_CLIENT_NOT_INSTALLED", "Claude Code is not installed.", "Install Claude Code, then rerun setup.");
      const previous = inspect(server);
      if (expectedPrevious) assertClientSnapshotUnchanged("claude", server, expectedPrevious, previous);
      if (previous.scope === "project" || previous.scope === "unknown" || previous.state === "unreadable" || previous.state === "disabled") {
        throw new SetupFailure("client_config", previous.scope === "project" ? "SETUP_EFFECTIVE_CONFIG_SHADOWED" : "SETUP_CLIENT_CONFIG_UNSAFE", `Claude Code ${server} cannot be modified because its scope/state is ${previous.scope ?? "unknown"}/${previous.state ?? "unknown"}.`, "Move the entry to a readable user scope or remove it explicitly, then rerun setup.", { server, previous });
      }
      if (previous.definition && definitionEquals(previous.definition, definition)) return previous;
      if (previous.raw && !previous.definition) throw new Error(`claude ${server} exists but could not be inspected safely`);
      if (previous.definition) removeOnly(server);
      try {
        add(executable, server, definition, commandCwd);
      } catch (error) {
        if (previous.definition) add(executable, server, previous.definition, commandCwd);
        throw error;
      }
      return previous;
    },
    remove(server, expected, previous, expectedCurrent) {
      if (!executable) throw new SetupFailure("client_missing", "SETUP_CLIENT_NOT_INSTALLED", "Claude Code is not installed.", "Reinstall Claude Code or rerun unset without selecting it; ownership will be kept.");
      const current = inspect(server);
      if (expectedCurrent) assertClientSnapshotUnchanged("claude", server, expectedCurrent, current);
      if (current.state === "absent" && !current.definition) return;
      if (current.scope !== "user" || current.state === "unreadable" || current.state === "disabled" || !current.definition) {
        throw new SetupFailure("client_config", "SETUP_CLIENT_CONFIG_UNSAFE", `Claude Code ${server} cannot be safely removed because its scope/state is ${current.scope ?? "unknown"}/${current.state ?? "unknown"}.`, "Repair the Claude Code configuration and retry unset; ownership has been kept.", { server, current });
      }
      if (!definitionEquals(current.definition, expected)) throw new SetupFailure("ownership", "SETUP_CLIENT_OWNERSHIP_MISMATCH", `Claude Code ${server} changed after setup; refusing to remove it.`, "Restore the setup-owned definition or resolve ownership manually, then retry unset.", { server, expected, current });
      removeOnly(server);
      if (previous?.definition) add(executable, server, previous.definition, commandCwd);
    },
  };
}
