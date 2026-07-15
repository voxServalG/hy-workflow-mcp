import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import type { ClientAdapter, ClientDetection, ClientServerSnapshot, McpDefinition, ServerName } from "../types.js";
import { definitionEquals, resolveExecutable, versionOf } from "./index.js";

function configPath(): string {
  if (process.env.OPENCODE_CONFIG) return path.resolve(process.env.OPENCODE_CONFIG);
  const dir = process.env.OPENCODE_CONFIG_DIR
    ?? (process.platform === "win32"
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "opencode")
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode"));
  return path.join(dir, "opencode.json");
}

function readDocument(): { file: string; text: string; value: any } {
  const file = configPath();
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "{}\n";
  const errors: any[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`OpenCode config is not valid JSONC: ${file}`);
  return { file, text, value: value ?? {} };
}

function fromEntry(entry: any): McpDefinition | null {
  if (!entry || typeof entry !== "object" || entry.type !== "local" || !Array.isArray(entry.command)) return null;
  const [command, ...args] = entry.command;
  if (typeof command !== "string" || !args.every((item: unknown) => typeof item === "string")) return null;
  return { command, args, ...(entry.environment && typeof entry.environment === "object" ? { env: entry.environment } : {}) };
}

function toEntry(definition: McpDefinition): any {
  return {
    type: "local",
    command: [definition.command, ...definition.args],
    enabled: true,
    ...(definition.env && Object.keys(definition.env).length ? { environment: definition.env } : {}),
  };
}

function writeEntry(server: ServerName, value: unknown): void {
  const document = readDocument();
  const edits = modify(document.text, ["mcp", server], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  fs.mkdirSync(path.dirname(document.file), { recursive: true });
  fs.writeFileSync(document.file, applyEdits(document.text, edits), "utf-8");
}

export function createOpenCodeAdapter(): ClientAdapter {
  const executable = resolveExecutable("opencode");
  const inspect = (server: ServerName): ClientServerSnapshot => {
    try {
      const document = readDocument();
      const raw = document.value?.mcp?.[server];
      return { definition: fromEntry(raw), raw };
    } catch (error: any) {
      return { definition: null, raw: { error: error?.message ?? String(error) } };
    }
  };
  return {
    name: "opencode",
    detect(): ClientDetection {
      const configured = (["hy-workflow", "docs-gardener"] as ServerName[]).filter(server => inspect(server).definition);
      return { name: "opencode", installed: Boolean(executable), executable, version: executable ? versionOf(executable) : null, configured };
    },
    inspect,
    install(server, definition) {
      if (!executable) throw new Error("opencode is not installed");
      const previous = inspect(server);
      if (previous.definition && definitionEquals(previous.definition, definition)) return previous;
      if (previous.raw && !previous.definition && !(previous.raw as any).error) {
        throw new Error(`OpenCode ${server} exists but is not a supported local MCP definition`);
      }
      writeEntry(server, toEntry(definition));
      return previous;
    },
    remove(server, expected, previous) {
      const current = inspect(server);
      if (!current.definition) return;
      if (!definitionEquals(current.definition, expected)) throw new Error(`OpenCode ${server} changed after setup; refusing to remove it`);
      writeEntry(server, previous?.raw ?? undefined);
    },
  };
}
