import type { ClientAdapter, ClientDetection, ClientServerSnapshot, McpDefinition, ServerName } from "../types.js";
import { definitionEquals, normalizeDefinition, resolveExecutable, runExecutable, versionOf } from "./index.js";

function add(executable: string, server: ServerName, definition: McpDefinition): void {
  const env = Object.entries(definition.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const result = runExecutable(executable, ["mcp", "add", ...env, server, "--", definition.command, ...definition.args]);
  if (!result.ok) throw new Error(`codex mcp add ${server} failed: ${result.stderr || result.stdout}`);
}

export function createCodexAdapter(): ClientAdapter {
  const executable = resolveExecutable("codex");
  const inspect = (server: ServerName): ClientServerSnapshot => {
    if (!executable) return { definition: null };
    const result = runExecutable(executable, ["mcp", "get", server, "--json"]);
    if (!result.ok) return { definition: null };
    try {
      const raw = JSON.parse(result.stdout);
      return { definition: normalizeDefinition(raw), raw };
    } catch {
      return { definition: null, raw: result.stdout };
    }
  };
  const removeOnly = (server: ServerName): void => {
    if (!executable) throw new Error("codex is not installed");
    const result = runExecutable(executable, ["mcp", "remove", server]);
    if (!result.ok) throw new Error(`codex mcp remove ${server} failed: ${result.stderr || result.stdout}`);
  };
  return {
    name: "codex",
    detect(): ClientDetection {
      const configured = (["hy-workflow", "docs-gardener"] as ServerName[]).filter(server => inspect(server).definition);
      return { name: "codex", installed: Boolean(executable), executable, version: executable ? versionOf(executable) : null, configured };
    },
    inspect,
    install(server, definition) {
      if (!executable) throw new Error("codex is not installed");
      const previous = inspect(server);
      if (previous.definition && definitionEquals(previous.definition, definition)) return previous;
      if (previous.raw && !previous.definition) throw new Error(`codex ${server} exists but could not be inspected safely`);
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
      if (!executable) throw new Error("codex is not installed");
      const current = inspect(server);
      if (!current.definition) return;
      if (!definitionEquals(current.definition, expected)) throw new Error(`codex ${server} changed after setup; refusing to remove it`);
      removeOnly(server);
      if (previous?.definition) add(executable, server, previous.definition);
    },
  };
}
