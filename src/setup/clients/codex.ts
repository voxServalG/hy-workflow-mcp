import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteText } from "../../runtime/user-paths.js";
import { SetupFailure, type ClientAdapter, type ClientConfigSource, type ClientDetection, type ClientServerSnapshot, type McpDefinition, type ServerName } from "../types.js";
import { assertClientSnapshotUnchanged } from "./effective.js";
import { definitionEquals, neutralCommandCwd, normalizeDefinition, resolveExecutable, runExecutable, versionOf } from "./index.js";

const STARTUP_TIMEOUT_SEC = 60;
const TOOL_TIMEOUT_SEC = 300;

function codexConfigPath(): string {
  return path.join(process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex"), "config.toml");
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

type ParsedCodexSource = ClientConfigSource & {
  raw: Record<string, unknown>;
  state: "active" | "disabled" | "unreadable";
};

function withoutComment(line: string): string {
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "\"") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
    } else if (quote === "'") {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseString(value: string): string {
  const text = value.trim();
  if (text.startsWith("\"") && text.endsWith("\"")) {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
  }
  if (text.startsWith("'") && text.endsWith("'") && !text.slice(1, -1).includes("'")) return text.slice(1, -1);
  throw new Error("expected a TOML string");
}

function parseStringArray(value: string): string[] {
  const text = value.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) throw new Error("expected a TOML string array");
  const result: string[] = [];
  let index = 1;
  while (index < text.length - 1) {
    while (/[\s,]/.test(text[index] ?? "")) index += 1;
    if (index >= text.length - 1) break;
    const quote = text[index];
    if (quote !== "\"" && quote !== "'") throw new Error("Codex args must contain only strings");
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length - 1) {
      const character = text[index];
      if (quote === "\"" && escaped) escaped = false;
      else if (quote === "\"" && character === "\\") escaped = true;
      else if (character === quote) { index += 1; break; }
      index += 1;
    }
    if (text[index - 1] !== quote) throw new Error("unterminated TOML string in args");
    result.push(parseString(text.slice(start, index)));
    while (/\s/.test(text[index] ?? "")) index += 1;
    if (index < text.length - 1 && text[index] !== ",") throw new Error("invalid TOML args separator");
  }
  return result;
}

function valueComplete(value: string): boolean {
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (const character of value) {
    if (quote === "\"") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
    } else if (quote === "'") {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") quote = character;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    if (square < 0 || curly < 0) return true;
  }
  return quote === null && square === 0 && curly === 0;
}

function assignments(lines: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = withoutComment(lines[index]).trim();
    if (!line) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`unsupported TOML in Codex MCP section: ${line}`);
    const key = match[1];
    if (result.has(key)) throw new Error(`duplicate Codex MCP key: ${key}`);
    let value = match[2];
    while (!valueComplete(value) && index + 1 < lines.length) value += `\n${withoutComment(lines[++index])}`;
    if (!valueComplete(value)) throw new Error(`unterminated Codex MCP value: ${key}`);
    result.set(key, value.trim());
  }
  return result;
}

function targetHeader(header: string, server: ServerName, suffix = ""): boolean {
  const escaped = server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expectedSuffix = suffix ? `\\s*\\.\\s*${suffix}` : "";
  return new RegExp(`^\\s*mcp_servers\\s*\\.\\s*(?:${escaped}|\"${escaped}\"|'${escaped}')${expectedSuffix}\\s*$`).test(header);
}

function tableSections(text: string): Array<{ header: string; lines: string[] }> {
  const result: Array<{ header: string; lines: string[] }> = [];
  let current: { header: string; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const clean = withoutComment(line).trim();
    const header = /^\[([^\]]+)\]$/.exec(clean);
    if (header) {
      current = { header: header[1], lines: [] };
      result.push(current);
    } else if (current) current.lines.push(line);
  }
  return result;
}

type TextSection = { header: string; start: number; end: number };

function textSections(text: string): TextSection[] {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  const pattern = /.*(?:\r\n|\n|$)/g;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) continue;
    lines.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  const sections: TextSection[] = [];
  for (const line of lines) {
    const header = /^\[([^\]]+)\]$/.exec(withoutComment(line.text).trim());
    if (!header) continue;
    if (sections.length) sections[sections.length - 1].end = line.start;
    sections.push({ header: header[1], start: line.start, end: text.length });
  }
  return sections;
}

function targetSectionBlocks(text: string, server: ServerName): string[] {
  return textSections(text)
    .filter(section => targetHeader(section.header, server) || targetHeader(section.header, server, "env"))
    .map(section => text.slice(section.start, section.end));
}

function sectionFingerprint(blocks: string[]): string {
  // Whitespace between this table and the next table is a document delimiter,
  // not part of the managed MCP entry. Codex may add one separator newline when
  // another server is registered. Codex 0.144.x also rewrites whole-number
  // timeouts from `60` to `60.0` while touching a sibling server. Normalize only
  // that representation; keep comments, keys, spacing and line endings strict.
  const canonical = (block: string): string => block
    .replace(/^([ \t]*(?:startup_timeout_sec|tool_timeout_sec)[ \t]*=[ \t]*)([0-9]+)\.0+([ \t]*(?:#[^\r\n]*)?)(\r?)$/gmu, "$1$2$3$4")
    .replace(/\s+$/u, "");
  return createHash("sha256").update(JSON.stringify(blocks.map(canonical))).digest("hex");
}

function replaceTargetSections(text: string, server: ServerName, blocks: string[]): string {
  const ranges = textSections(text).filter(section => targetHeader(section.header, server) || targetHeader(section.header, server, "env"));
  const insertion = ranges[0]?.start ?? text.length;
  let without = text;
  for (const range of [...ranges].reverse()) without = without.slice(0, range.start) + without.slice(range.end);
  const adjustedInsertion = insertion - ranges.filter(range => range.end <= insertion).reduce((sum, range) => sum + range.end - range.start, 0);
  let restored = blocks.join("");
  if (restored && adjustedInsertion === without.length && without && !without.endsWith("\n") && !restored.startsWith("\n")) restored = `\n${restored}`;
  return without.slice(0, adjustedInsertion) + restored + without.slice(adjustedInsertion);
}

function assertPlainConfigFile(file: string): void {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`Codex config must not be a symbolic link: ${file}`);
}

function parseInlineEnv(value: string): Record<string, string> {
  const text = value.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) throw new Error("expected an inline TOML env table");
  const env = new Map<string, string>();
  for (const part of text.slice(1, -1).split(",")) {
    if (!part.trim()) continue;
    const match = /^\s*(?:\"([^\"]+)\"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*(.+?)\s*$/.exec(part);
    if (!match) throw new Error("unsupported inline TOML env table");
    const key = match[1] ?? match[2] ?? match[3];
    if (env.has(key)) throw new Error(`duplicate Codex MCP env key: ${key}`);
    env.set(key, parseString(match[4]));
  }
  return Object.fromEntries(env);
}

function readCodexSource(file: string, server: ServerName): ParsedCodexSource | null {
  if (!fs.existsSync(file)) return null;
  try {
    assertPlainConfigFile(file);
    const text = fs.readFileSync(file, "utf-8");
    const sections = tableSections(text);
    const bases = sections.filter(section => targetHeader(section.header, server));
    const envs = sections.filter(section => targetHeader(section.header, server, "env"));
    if (!bases.length && !envs.length) return null;
    if (bases.length !== 1 || envs.length > 1) throw new Error("duplicate or incomplete Codex MCP tables");
    const values = assignments(bases[0].lines);
    const supported = new Set(["command", "args", "enabled", "startup_timeout_sec", "tool_timeout_sec", "env"]);
    const unknown = [...values.keys()].filter(key => !supported.has(key));
    if (unknown.length) throw new Error(`unsupported Codex MCP keys: ${unknown.join(", ")}`);
    const command = parseString(values.get("command") ?? "");
    const args = values.has("args") ? parseStringArray(values.get("args")!) : [];
    const enabledText = values.get("enabled");
    if (enabledText !== undefined && enabledText !== "true" && enabledText !== "false") throw new Error("Codex enabled must be a boolean");
    const enabled = enabledText !== "false";
    const integer = (key: string): number | undefined => {
      const value = values.get(key);
      if (value === undefined) return undefined;
      // Codex CLI 0.144.x serializes integer-valued timeout settings as TOML
      // floats (`60.0`, `300.0`) whenever it rewrites the shared config file.
      if (!/^[0-9]+(?:\.0+)?$/.test(value)) throw new Error(`Codex ${key} must be a non-negative whole number`);
      return Number(value);
    };
    const startup = integer("startup_timeout_sec");
    const tool = integer("tool_timeout_sec");
    let env: Record<string, string> | undefined;
    if (values.has("env")) env = parseInlineEnv(values.get("env")!);
    if (envs.length) {
      if (env) throw new Error("Codex env is defined twice");
      env = Object.fromEntries([...assignments(envs[0].lines)].map(([key, value]) => [key, parseString(value)]));
    }
    const definition: McpDefinition = { command, args, ...(env && Object.keys(env).length ? { env } : {}) };
    const sectionBlocks = targetSectionBlocks(text, server);
    return {
      scope: "unknown",
      source: file,
      definition,
      enabled,
      state: enabled ? "active" : "disabled",
      raw: {
        present: true,
        command,
        args,
        enabled,
        startup_timeout_sec: startup,
        tool_timeout_sec: tool,
        sectionBlocks,
        sectionFingerprint: sectionFingerprint(sectionBlocks),
        configMode: fs.statSync(file).mode & 0o777,
        ...(env ? { env } : {}),
      },
    };
  } catch (error: any) {
    return {
      scope: "unknown",
      source: file,
      definition: null,
      enabled: null,
      state: "unreadable",
      raw: { present: true, error: error?.message ?? String(error) },
    };
  }
}

function setTimeouts(server: ServerName, startup = STARTUP_TIMEOUT_SEC, tool = TOOL_TIMEOUT_SEC): void {
  const file = codexConfigPath();
  if (!fs.existsSync(file)) throw new Error(`Codex config was not created: ${file}`);
  assertPlainConfigFile(file);
  const text = fs.readFileSync(file, "utf-8");
  const section = textSections(text).find(candidate => targetHeader(candidate.header, server));
  if (!section) throw new Error(`Codex MCP section was not created for ${server}`);
  type PreservedLine = { content: string; ending: string };
  const lines: PreservedLine[] = [];
  for (const match of text.slice(section.start, section.end).matchAll(/([^\r\n]*)(\r\n|\n|$)/g)) {
    if (!match[0]) continue;
    lines.push({ content: match[1], ending: match[2] });
  }
  const preferredEnding = lines.find(line => line.ending)?.ending ?? (text.includes("\r\n") ? "\r\n" : "\n");
  const set = (key: string, value: number): void => {
    const pattern = new RegExp(`^(\\s*${key}\\s*=\\s*)[0-9]+(?:\\.0+)?(\\s*(?:#.*)?)$`);
    const found = lines.findIndex((line, index) => index > 0 && pattern.test(line.content));
    if (found >= 0) {
      lines[found].content = lines[found].content.replace(pattern, `$1${value}$2`);
      return;
    }
    let insertion = lines.length;
    while (insertion > 1 && lines[insertion - 1].content.trim() === "") insertion -= 1;
    if (insertion > 0 && lines[insertion - 1].ending === "") lines[insertion - 1].ending = preferredEnding;
    lines.splice(insertion, 0, { content: `${key} = ${value}`, ending: preferredEnding });
  };
  set("startup_timeout_sec", startup);
  set("tool_timeout_sec", tool);
  const updatedSection = lines.map(line => line.content + line.ending).join("");
  atomicWriteText(file, text.slice(0, section.start) + updatedSection + text.slice(section.end));
}

function restoreSnapshot(server: ServerName, snapshot: ClientServerSnapshot): void {
  if (!snapshot.definition) return;
  const file = codexConfigPath();
  const raw = snapshot.raw as any;
  const blocks = Array.isArray(raw?.sectionBlocks) && raw.sectionBlocks.every((value: unknown) => typeof value === "string")
    ? raw.sectionBlocks as string[]
    : null;
  if (!blocks) throw new Error(`Codex ${server} cannot be restored losslessly because its original section snapshot is unavailable`);
  assertPlainConfigFile(file);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  atomicWriteText(file, replaceTargetSections(current, server, blocks), Number(raw?.configMode ?? 0o600));
  if (Number.isInteger(raw?.configMode)) fs.chmodSync(file, Number(raw.configMode));
}

function restoreAbsentConfigFile(snapshot: ClientServerSnapshot): void {
  const raw = snapshot.raw as any;
  if (snapshot.definition || snapshot.state !== "absent" || raw?.configFileExisted !== false) return;
  const file = codexConfigPath();
  if (!fs.existsSync(file)) return;
  assertPlainConfigFile(file);
  // A Codex config file is shared by every MCP entry. During a normal unset,
  // sibling entries installed by this same setup transaction may still be
  // present; preserve any content and let the last removal delete the file.
  // This also avoids deleting unrelated content added concurrently by a user.
  if (fs.readFileSync(file, "utf-8").trim()) return;
  fs.rmSync(file);
}

function add(executable: string, server: ServerName, definition: McpDefinition, cwd: string): void {
  const env = Object.entries(definition.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const result = runExecutable(executable, ["mcp", "add", ...env, server, "--", definition.command, ...definition.args], 15_000, { cwd });
  if (!result.ok) throw new Error(`codex mcp add ${server} failed: ${result.stderr || result.stdout}`);
}

export function createCodexAdapter(root = process.env.HY_WORKFLOW_PROJECT_ROOT ?? process.cwd()): ClientAdapter {
  const executable = resolveExecutable("codex");
  const commandCwd = neutralCommandCwd(root);
  const inspect = (server: ServerName): ClientServerSnapshot => {
    const userFile = codexConfigPath();
    const absentSnapshot = (sources: ClientConfigSource[]): ClientServerSnapshot => {
      const existed = fs.existsSync(userFile);
      return {
        definition: null,
        raw: { configFileExisted: existed },
        source: userFile,
        scope: "user",
        state: "absent",
        sources,
        ownedDefinition: null,
      };
    };
    if (locationInside(root, userFile)) {
      return {
        definition: null,
        raw: { error: "Codex user config path points inside the project; file was not inspected" },
        source: userFile,
        scope: "unknown",
        enabled: null,
        state: "unreadable",
        sources: [],
        ownedDefinition: null,
      };
    }
    const user = readCodexSource(userFile, server);
    const sources: ClientConfigSource[] = [];
    if (user) sources.push({ scope: "user", source: user.source, definition: user.definition, enabled: user.enabled });
    if (user) {
      return {
        definition: user.definition,
        raw: user.raw,
        source: user.source,
        scope: "user",
        enabled: user.enabled,
        state: user.state,
        sources,
        ownedDefinition: user.definition,
      };
    }
    if (!executable) return absentSnapshot(sources);
    const result = runExecutable(executable, ["mcp", "get", server, "--json"], 15_000, { cwd: commandCwd });
    if (!result.ok) {
      const diagnostic = `${result.stderr}\n${result.stdout}`.trim();
      if (/not found|does not exist|no mcp server|unknown mcp server/i.test(diagnostic)) {
        return absentSnapshot(sources);
      }
      return { definition: null, raw: { error: diagnostic || "codex mcp get failed" }, source: userFile, scope: "user", state: "unreadable", sources, ownedDefinition: null };
    }
    try {
      const raw = JSON.parse(result.stdout);
      const definition = normalizeDefinition(raw);
      const enabled = raw?.enabled !== false;
      return { definition, raw, source: userFile, scope: "user", enabled, state: !definition ? "unreadable" : enabled ? "active" : "disabled", sources, ownedDefinition: definition };
    } catch {
      return { definition: null, raw: result.stdout, source: userFile, scope: "user", state: "unreadable", sources };
    }
  };
  const removeOnly = (server: ServerName): void => {
    if (!executable) throw new Error("codex is not installed");
    const result = runExecutable(executable, ["mcp", "remove", server], 15_000, { cwd: commandCwd });
    if (!result.ok) throw new Error(`codex mcp remove ${server} failed: ${result.stderr || result.stdout}`);
  };
  return {
    name: "codex",
    detect(): ClientDetection {
      const configured = (["hy-workflow", "docs-gardener"] as ServerName[]).filter(server => inspect(server).definition);
      return { name: "codex", installed: Boolean(executable), executable, version: executable ? versionOf(executable, commandCwd) : null, configured };
    },
    inspect,
    install(server, definition, expectedPrevious) {
      if (!executable) throw new SetupFailure("client_missing", "SETUP_CLIENT_NOT_INSTALLED", "Codex is not installed.", "Install Codex, then rerun setup.");
      const previous = inspect(server);
      if (expectedPrevious) assertClientSnapshotUnchanged("codex", server, expectedPrevious, previous);
      if (previous.scope === "project") {
        throw new SetupFailure(
          "client_shadowed",
          "SETUP_EFFECTIVE_CONFIG_SHADOWED",
          `Codex ${server} is controlled by project configuration at ${previous.source}.`,
          "Remove or migrate that project-owned entry explicitly; setup will not modify tracked legacy configuration.",
          { server, source: previous.source, state: previous.state, sources: previous.sources },
        );
      }
      if (previous.state === "disabled" || previous.state === "unreadable" || previous.scope === "unknown") {
        throw new SetupFailure(
          "client_config",
          "SETUP_CLIENT_CONFIG_UNSAFE",
          `Codex ${server} cannot be modified because its effective configuration is ${previous.state ?? "unknown"}.`,
          "Repair, enable, or explicitly remove the existing Codex entry, then rerun setup.",
          { server, source: previous.source, state: previous.state, sources: previous.sources, raw: previous.raw },
        );
      }
      if (previous.definition && definitionEquals(previous.definition, definition)) {
        const raw = previous.raw as any;
        if (Number(raw?.startup_timeout_sec) !== STARTUP_TIMEOUT_SEC || Number(raw?.tool_timeout_sec) !== TOOL_TIMEOUT_SEC) {
          setTimeouts(server);
        }
        return previous;
      }
      if (previous.raw && !previous.definition && previous.state !== "absent") {
        throw new Error(`codex ${server} exists but could not be inspected safely`);
      }
      if (previous.definition) removeOnly(server);
      try {
        add(executable, server, definition, commandCwd);
        setTimeouts(server);
      } catch (error) {
        if (previous.definition) {
          try { removeOnly(server); } catch {}
          restoreSnapshot(server, previous);
        }
        throw error;
      }
      return previous;
    },
    remove(server, expected, previous, expectedCurrent) {
      if (!executable) throw new SetupFailure("client_missing", "SETUP_CLIENT_NOT_INSTALLED", "Codex is not installed.", "Reinstall Codex or rerun unset without selecting it; ownership will be kept.");
      const current = inspect(server);
      if (expectedCurrent) assertClientSnapshotUnchanged("codex", server, expectedCurrent, current);
      if (current.scope === "project") {
        throw new SetupFailure(
          "client_shadowed",
          "SETUP_EFFECTIVE_CONFIG_SHADOWED",
          `Codex ${server} is controlled by project configuration at ${current.source}.`,
          "Migrate the project-owned entry explicitly; unset will not modify tracked project configuration.",
          { server, source: current.source, state: current.state, sources: current.sources },
        );
      }
      if (current.state === "absent" && !current.definition) return;
      if (current.state === "disabled" || current.state === "unreadable" || current.scope === "unknown" || !current.definition) {
        throw new SetupFailure("client_config", "SETUP_CLIENT_CONFIG_UNSAFE", `Codex ${server} cannot be safely removed because its effective configuration is ${current.state ?? "unknown"}.`, "Repair the Codex configuration and retry unset; ownership has been kept.", { server, current });
      }
      if (!definitionEquals(current.definition, expected)) throw new SetupFailure("ownership", "SETUP_CLIENT_OWNERSHIP_MISMATCH", `Codex ${server} changed after setup; refusing to remove it.`, "Restore the setup-owned definition or resolve ownership manually, then retry unset.", { server, expected, current });
      removeOnly(server);
      if (previous?.definition) {
        restoreSnapshot(server, previous);
      } else if (previous) {
        restoreAbsentConfigFile(previous);
      }
    },
  };
}
