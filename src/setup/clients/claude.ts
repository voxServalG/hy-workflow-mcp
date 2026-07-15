import type { ClientAdapter, ClientDetection, ClientServerSnapshot, McpDefinition, ServerName } from "../types.js";
import { definitionEquals, resolveExecutable, runExecutable, versionOf } from "./index.js";

function parseGet(output: string): McpDefinition | null {
  const command = /^\s*Command:\s*(.+?)\s*$/im.exec(output)?.[1]?.trim();
  if (!command) return null;
  const argsText = /^\s*Args:\s*(.*?)\s*$/im.exec(output)?.[1]?.trim() ?? "";
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
  return { command, args };
}

function add(executable: string, server: ServerName, definition: McpDefinition): void {
  const env = Object.entries(definition.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const result = runExecutable(executable, ["mcp", "add", "-s", "user", ...env, server, "--", definition.command, ...definition.args]);
  if (!result.ok) throw new Error(`claude mcp add ${server} failed: ${result.stderr || result.stdout}`);
}

export function createClaudeAdapter(): ClientAdapter {
  const executable = resolveExecutable("claude");
  const inspect = (server: ServerName): ClientServerSnapshot => {
    if (!executable) return { definition: null };
    const result = runExecutable(executable, ["mcp", "get", server]);
    if (!result.ok) return { definition: null };
    return { definition: parseGet(result.stdout), raw: result.stdout };
  };
  const removeOnly = (server: ServerName): void => {
    if (!executable) throw new Error("claude is not installed");
    const result = runExecutable(executable, ["mcp", "remove", "-s", "user", server]);
    if (!result.ok) throw new Error(`claude mcp remove ${server} failed: ${result.stderr || result.stdout}`);
  };
  return {
    name: "claude",
    detect(): ClientDetection {
      const configured = (["hy-workflow", "docs-gardener"] as ServerName[]).filter(server => Boolean(inspect(server).definition ?? inspect(server).raw));
      return { name: "claude", installed: Boolean(executable), executable, version: executable ? versionOf(executable) : null, configured };
    },
    inspect,
    install(server, definition) {
      if (!executable) throw new Error("claude is not installed");
      const previous = inspect(server);
      if (previous.definition && definitionEquals(previous.definition, definition)) return previous;
      if (previous.raw && !previous.definition) throw new Error(`claude ${server} exists but could not be inspected safely`);
      if (previous.definition) removeOnly(server);
      try {
        add(executable, server, definition);
      } catch (error) {
        if (previous.definition) add(executable, server, previous.definition);
        throw error;
      }
      return previous;
    },
    remove(server, expected, previous) {
      if (!executable) throw new Error("claude is not installed");
      const current = inspect(server);
      if (!current.definition) return;
      if (!definitionEquals(current.definition, expected)) throw new Error(`claude ${server} changed after setup; refusing to remove it`);
      removeOnly(server);
      if (previous?.definition) add(executable, server, previous.definition);
    },
  };
}
