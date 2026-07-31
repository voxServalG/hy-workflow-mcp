import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { applyEdits, findNodeAtLocation, modify, parse, parseTree } from "jsonc-parser";
import { SetupFailure, type ClientAdapter, type ClientConfigSource, type ClientDetection, type ClientServerSnapshot, type McpDefinition, type ServerName } from "../types.js";
import { assertClientSnapshotUnchanged } from "./effective.js";
import { definitionEquals, neutralCommandCwd, resolveExecutable, versionOf } from "./index.js";

function configPath(): string {
  if (process.env.OPENCODE_CONFIG) return path.resolve(process.env.OPENCODE_CONFIG);
  const dir = process.env.OPENCODE_CONFIG_DIR
    ?? (process.platform === "win32"
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "opencode")
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode"));
  return path.join(dir, "opencode.json");
}

function canonicalLocation(file: string): string {
  try { return fs.realpathSync(file); }
  catch {
    try { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); }
    catch { return path.resolve(file); }
  }
}

function locationInside(root: string, target: string): boolean {
  const inside = (base: string, candidate: string): boolean => {
    const relative = path.relative(base, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  return inside(path.resolve(root), path.resolve(target)) || inside(canonicalLocation(root), canonicalLocation(target));
}

function readDocument(file = configPath()): { file: string; text: string; value: any } {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`OpenCode config must not be a symbolic link: ${file}`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "{}\n";
  const errors: any[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`OpenCode config is not valid JSONC: ${file}`);
  return { file, text, value: value ?? {} };
}

type OpenCodeRawSnapshot = {
  entry: unknown;
  entryText: string;
  entryFingerprint: string;
  configMode: number;
};

function rawSnapshot(document: ReturnType<typeof readDocument>, server: ServerName, entry: unknown): OpenCodeRawSnapshot {
  const tree = parseTree(document.text, [], { allowTrailingComma: true, disallowComments: false });
  const node = tree ? findNodeAtLocation(tree, ["mcp", server]) : undefined;
  if (!node) throw new Error(`OpenCode ${server} entry could not be located losslessly in ${document.file}`);
  const entryText = document.text.slice(node.offset, node.offset + node.length);
  return {
    entry,
    entryText,
    entryFingerprint: createHash("sha256").update(entryText).digest("hex"),
    configMode: fs.statSync(document.file).mode & 0o777,
  };
}

function decodedRaw(raw: unknown): { entry: unknown; entryText?: string; configMode?: number } {
  if (raw && typeof raw === "object" && "entry" in raw && "entryFingerprint" in raw) {
    const snapshot = raw as OpenCodeRawSnapshot;
    return { entry: snapshot.entry, entryText: snapshot.entryText, configMode: snapshot.configMode };
  }
  return { entry: raw };
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

function writeEntry(server: ServerName, value: unknown, exactEntryText?: string, restoreMode?: number): void {
  const document = readDocument();
  let output: string;
  if (exactEntryText !== undefined) {
    const tree = parseTree(document.text, [], { allowTrailingComma: true, disallowComments: false });
    const node = tree ? findNodeAtLocation(tree, ["mcp", server]) : undefined;
    if (!node) throw new Error(`OpenCode ${server} cannot be restored losslessly because the setup-owned entry is absent`);
    output = document.text.slice(0, node.offset) + exactEntryText + document.text.slice(node.offset + node.length);
  } else {
    const edits = modify(document.text, ["mcp", server], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    output = applyEdits(document.text, edits);
  }
  fs.mkdirSync(path.dirname(document.file), { recursive: true });
  const mode = fs.existsSync(document.file) ? fs.statSync(document.file).mode & 0o777 : 0o600;
  const temporary = path.join(path.dirname(document.file), `.${path.basename(document.file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, output, { encoding: "utf-8", mode, flag: "wx" });
    fs.renameSync(temporary, document.file);
    if (Number.isInteger(restoreMode)) fs.chmodSync(document.file, restoreMode!);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function createOpenCodeAdapter(root = process.env.HY_WORKFLOW_PROJECT_ROOT ?? process.cwd()): ClientAdapter {
  const executable = resolveExecutable("opencode");
  const projectRoot = path.resolve(root);
  const commandCwd = neutralCommandCwd(projectRoot);
  const inspect = (server: ServerName): ClientServerSnapshot => {
    const userFile = configPath();
    if (locationInside(projectRoot, userFile)) {
      return {
        definition: null,
        raw: { error: "OpenCode user config path points inside the project; file was not inspected" },
        source: userFile,
        scope: "unknown",
        state: "unreadable",
        sources: [],
        ownedDefinition: null,
      };
    }
    try {
      const sources: ClientConfigSource[] = [];
      const userDocument = readDocument(userFile);
      const userRaw = userDocument.value?.mcp?.[server];
      if (userRaw !== undefined) {
        sources.push({ scope: "user", source: userDocument.file, definition: fromEntry(userRaw), enabled: userRaw?.enabled !== false });
      }
      const effective = sources[0];
      if (!effective) return { definition: null, source: userDocument.file, scope: "user", state: "absent", sources, ownedDefinition: null };
      const raw = rawSnapshot(userDocument, server, userRaw);
      const state = !effective.definition ? "unreadable" : effective.enabled === false ? "disabled" : "active";
      return {
        definition: effective.definition,
        raw,
        source: effective.source,
        scope: effective.scope,
        enabled: effective.enabled,
        state,
        sources,
        ownedDefinition: effective.definition,
      };
    } catch (error: any) {
      return { definition: null, raw: { error: error?.message ?? String(error) }, state: "unreadable", scope: "unknown" };
    }
  };
  return {
    name: "opencode",
    detect(): ClientDetection {
      const configured = (["hy-workflow", "docs-gardener"] as ServerName[]).filter(server => inspect(server).definition);
      return { name: "opencode", installed: Boolean(executable), executable, version: executable ? versionOf(executable, commandCwd) : null, configured };
    },
    inspect,
    install(server, definition, expectedPrevious) {
      if (!executable) throw new SetupFailure("client_missing", "SETUP_CLIENT_NOT_INSTALLED", "OpenCode is not installed.", "Install OpenCode, then rerun setup.");
      const previous = inspect(server);
      if (expectedPrevious) assertClientSnapshotUnchanged("opencode", server, expectedPrevious, previous);
      if (previous.scope === "project") {
        throw new SetupFailure(
          "client_shadowed",
          "SETUP_EFFECTIVE_CONFIG_SHADOWED",
          `OpenCode ${server} is shadowed by project configuration at ${previous.source}.`,
          "Remove or migrate that project-owned entry explicitly; setup will not modify tracked legacy configuration.",
          { server, source: previous.source, sources: previous.sources },
        );
      }
      if (previous.enabled === false || previous.state === "unreadable" || previous.scope === "unknown") {
        throw new SetupFailure(
          "client_config",
          "SETUP_CLIENT_CONFIG_UNSAFE",
          `OpenCode ${server} cannot be modified because its effective configuration is ${previous.state ?? "unknown"} at ${previous.source ?? "unknown source"}.`,
          "Repair, enable, or remove the existing entry explicitly, then rerun setup.",
          { server, source: previous.source, state: previous.state, raw: previous.raw },
        );
      }
      if (previous.definition && definitionEquals(previous.definition, definition)) return previous;
      if (previous.raw && !previous.definition && !(previous.raw as any).error) {
        throw new Error(`OpenCode ${server} exists but is not a supported local MCP definition`);
      }
      writeEntry(server, toEntry(definition));
      return previous;
    },
    remove(server, expected, previous, expectedCurrent) {
      const current = inspect(server);
      if (expectedCurrent) assertClientSnapshotUnchanged("opencode", server, expectedCurrent, current);
      if (current.scope === "project") {
        throw new SetupFailure("client_shadowed", "SETUP_EFFECTIVE_CONFIG_SHADOWED", `OpenCode ${server} is controlled by project configuration at ${current.source}.`, "Migrate the project-owned entry explicitly; unset will not modify tracked project configuration.", { server, current });
      }
      if (current.state === "absent" && !current.definition) return;
      if (current.state === "unreadable" || current.state === "disabled" || current.scope === "unknown" || !current.definition) {
        throw new SetupFailure("client_config", "SETUP_CLIENT_CONFIG_UNSAFE", `OpenCode ${server} cannot be safely removed because its effective configuration is ${current.state ?? "unknown"}.`, "Repair the OpenCode configuration and retry unset; ownership has been kept.", { server, current });
      }
      if (!definitionEquals(current.definition, expected)) throw new SetupFailure("ownership", "SETUP_CLIENT_OWNERSHIP_MISMATCH", `OpenCode ${server} changed after setup; refusing to remove it.`, "Restore the setup-owned definition or resolve ownership manually, then retry unset.", { server, expected, current });
      const restoration = decodedRaw(previous?.raw);
      writeEntry(server, restoration.entry, restoration.entryText, restoration.configMode);
    },
  };
}
