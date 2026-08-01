import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDocument, visit } from "yaml";
import { isJsonObject } from "../cli/input.js";
import { HyWorkflowError } from "../cli/output.js";
import { isTrackedFile } from "../git/repository.js";
import { absoluteRepositoryPath, normalizeRepositoryPath } from "./paths.js";
import type {
  ObligationKind,
  ObligationStatus,
  ProtocolDocument,
  ProtocolObligation,
  VerificationCommand,
  VerificationScale,
} from "./types.js";

export const PROTOCOL_FILE = "hy-workflow.yml";
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const ID_PATTERN = /^(?:INV|INC)-[A-Z0-9][A-Z0-9._-]{1,62}$/;

export type LoadedProtocol = {
  path: string;
  hash: string;
  document: ProtocolDocument;
};

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (unknown.length) {
    throw new HyWorkflowError("PROTOCOL_UNKNOWN_FIELDS", `${label} contains unknown fields: ${unknown.join(", ")}.`);
  }
}
function requiredString(value: unknown, label: string, min = 1, max = 512): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < min || value.length > max) {
    throw new HyWorkflowError("PROTOCOL_FIELD_INVALID", `${label} must be a trimmed string of ${min}-${max} characters.`);
  }
  return value;
}

function stringArray(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) {
    throw new HyWorkflowError("PROTOCOL_FIELD_INVALID", `${label} must contain 1-${maxItems} strings.`);
  }
  const result = value.map((item, index) => requiredString(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new HyWorkflowError("PROTOCOL_FIELD_DUPLICATE", `${label} must not contain duplicates.`);
  }
  return result;
}

function validateArgv(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new HyWorkflowError("PROTOCOL_ARGV_INVALID", `${label} must contain 1-32 argv elements.`);
  }
  let totalBytes = 0;
  const argv = value.map((item, index) => {
    const argument = requiredString(item, `${label}[${index}]`, 1, 2048);
    if (/[\u0000-\u001f\u007f]/.test(argument)) {
      throw new HyWorkflowError("PROTOCOL_ARGV_INVALID", `${label}[${index}] contains a control character.`);
    }
    totalBytes += Buffer.byteLength(argument, "utf8");
    return argument;
  });
  if (totalBytes > 16_384) {
    throw new HyWorkflowError("PROTOCOL_ARGV_INVALID", `${label} exceeds 16384 UTF-8 bytes.`);
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
    throw new HyWorkflowError("PROTOCOL_ARGV_INVALID", `${label}[0] must be an executable, not an environment assignment.`);
  }
  const executable = path.basename(argv[0]).toLowerCase().replace(/\.exe$/, "");
  const argumentsLower = argv.slice(1).map(item => item.toLowerCase());
  const shellString = ["sh", "bash", "zsh", "fish", "dash", "ksh"].includes(executable)
    ? argumentsLower.includes("-c")
    : executable === "cmd"
      ? argumentsLower.includes("/c")
      : ["powershell", "pwsh"].includes(executable)
        ? argumentsLower.includes("-command") || argumentsLower.includes("-encodedcommand")
        : false;
  if (shellString) {
    throw new HyWorkflowError("PROTOCOL_SHELL_STRING_FORBIDDEN", `${label} must use argv, not a shell command string.`);
  }
  return argv;
}

function commandFrom(value: unknown, label: string): VerificationCommand {
  if (!isJsonObject(value)) throw new HyWorkflowError("PROTOCOL_FIELD_INVALID", `${label} must be an object.`);
  exactKeys(value, ["argv", "expected_exit_code"], label);
  if (!Number.isInteger(value.expected_exit_code)
    || Number(value.expected_exit_code) < 0 || Number(value.expected_exit_code) > 255) {
    throw new HyWorkflowError("PROTOCOL_EXIT_CODE_INVALID", `${label}.expected_exit_code must be an integer from 0 to 255.`);
  }
  return { argv: validateArgv(value.argv, `${label}.argv`), expectedExitCode: Number(value.expected_exit_code) };
}

function obligationFrom(value: unknown, index: number): ProtocolObligation {
  const label = `obligations[${index}]`;
  if (!isJsonObject(value)) throw new HyWorkflowError("PROTOCOL_FIELD_INVALID", `${label} must be an object.`);
  exactKeys(value, ["id", "kind", "status", "statement", "sources", "applies_to", "verification", "superseded_by"], label);
  const id = requiredString(value.id, `${label}.id`, 4, 66);
  if (!ID_PATTERN.test(id)) {
    throw new HyWorkflowError("PROTOCOL_ID_INVALID", `${label}.id must start with INV- or INC- and use stable uppercase identifier characters.`);
  }
  if (value.kind !== "invariant" && value.kind !== "incident") {
    throw new HyWorkflowError("PROTOCOL_KIND_INVALID", `${label}.kind must be invariant or incident.`);
  }
  const kind = value.kind as ObligationKind;
  const rawStatus = value.status ?? "active";
  if (!["active", "superseded", "retired"].includes(String(rawStatus))) {
    throw new HyWorkflowError("PROTOCOL_STATUS_INVALID", `${label}.status must be active, superseded, or retired.`);
  }
  const status = rawStatus as ObligationStatus;
  const statement = requiredString(value.statement, `${label}.statement`, 10, 1000);
  const sources = stringArray(value.sources, `${label}.sources`, 16)
    .map((item, sourceIndex) => normalizeRepositoryPath(item, `${label}.sources[${sourceIndex}]`, false));
  if (!isJsonObject(value.applies_to)) {
    throw new HyWorkflowError("PROTOCOL_FIELD_INVALID", `${label}.applies_to must be an object.`);
  }
  exactKeys(value.applies_to, ["paths"], `${label}.applies_to`);
  const appliesTo = stringArray(value.applies_to.paths, `${label}.applies_to.paths`, 64)
    .map((item, pathIndex) => normalizeRepositoryPath(item, `${label}.applies_to.paths[${pathIndex}]`, true));
  if (!isJsonObject(value.verification)) {
    throw new HyWorkflowError("PROTOCOL_FIELD_INVALID", `${label}.verification must be an object.`);
  }
  exactKeys(value.verification, ["scale", "commands"], `${label}.verification`);
  if (!["small", "medium", "large"].includes(String(value.verification.scale))) {
    throw new HyWorkflowError("PROTOCOL_SCALE_INVALID", `${label}.verification.scale must be small, medium, or large.`);
  }
  const scale = value.verification.scale as VerificationScale;
  if (!Array.isArray(value.verification.commands)
    || value.verification.commands.length < 1 || value.verification.commands.length > 16) {
    throw new HyWorkflowError("PROTOCOL_FIELD_INVALID", `${label}.verification.commands must contain 1-16 commands.`);
  }
  const commands = value.verification.commands.map((item, commandIndex) =>
    commandFrom(item, `${label}.verification.commands[${commandIndex}]`));
  const commandKeys = commands.map(command => JSON.stringify([command.argv, command.expectedExitCode]));
  if (new Set(commandKeys).size !== commandKeys.length) {
    throw new HyWorkflowError("PROTOCOL_COMMAND_DUPLICATE", `${label}.verification.commands contains a duplicate command.`);
  }
  const supersededBy = value.superseded_by === undefined
    ? undefined
    : requiredString(value.superseded_by, `${label}.superseded_by`, 4, 66);
  if ((status === "superseded") !== Boolean(supersededBy)) {
    throw new HyWorkflowError(
      "PROTOCOL_SUPERSESSION_INVALID",
      `${label} must set superseded_by exactly when status is superseded.`,
    );
  }
  return { id, kind, status, statement, sources, appliesTo, scale, commands, ...(supersededBy ? { supersededBy } : {}) };
}

function assertSource(root: string, relativePath: string): void {
  const absolute = absoluteRepositoryPath(root, relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    throw new HyWorkflowError("PROTOCOL_SOURCE_MISSING", `Protocol source does not exist: ${relativePath}`, relativePath);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new HyWorkflowError("PROTOCOL_SOURCE_UNSAFE", `Protocol source must be a regular file: ${relativePath}`, relativePath);
  }
  const real = fs.realpathSync.native(absolute);
  const relativeReal = path.relative(root, real);
  if (!relativeReal || relativeReal.startsWith("..") || path.isAbsolute(relativeReal)) {
    throw new HyWorkflowError("PROTOCOL_SOURCE_UNSAFE", `Protocol source escapes the repository: ${relativePath}`, relativePath);
  }
  if (!isTrackedFile(root, relativePath)) {
    throw new HyWorkflowError("PROTOCOL_SOURCE_UNTRACKED", `Protocol source must be tracked in Git: ${relativePath}`, relativePath);
  }
}

function assertSupersessionGraph(obligations: ProtocolObligation[]): void {
  const byId = new Map(obligations.map(item => [item.id, item]));
  for (const obligation of obligations) {
    if (!obligation.supersededBy) continue;
    if (obligation.supersededBy === obligation.id || !byId.has(obligation.supersededBy)) {
      throw new HyWorkflowError(
        "PROTOCOL_SUPERSESSION_INVALID",
        `${obligation.id}.superseded_by must name a different obligation in this protocol.`,
      );
    }
    const seen = new Set<string>([obligation.id]);
    let current: ProtocolObligation | undefined = obligation;
    while (current?.supersededBy) {
      if (seen.has(current.supersededBy)) {
        throw new HyWorkflowError("PROTOCOL_SUPERSESSION_CYCLE", `Supersession cycle includes ${current.supersededBy}.`);
      }
      seen.add(current.supersededBy);
      current = byId.get(current.supersededBy);
    }
  }
}

export function loadProtocol(root: string): LoadedProtocol {
  const protocolPath = path.join(root, PROTOCOL_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(protocolPath);
  } catch {
    throw new HyWorkflowError("PROTOCOL_NOT_FOUND", `${PROTOCOL_FILE} is not present at the repository root.`, PROTOCOL_FILE);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROTOCOL_BYTES) {
    throw new HyWorkflowError(
      "PROTOCOL_FILE_UNSAFE",
      `${PROTOCOL_FILE} must be a regular file no larger than ${MAX_PROTOCOL_BYTES} bytes.`,
      PROTOCOL_FILE,
    );
  }
  if (!isTrackedFile(root, PROTOCOL_FILE)) {
    throw new HyWorkflowError("PROTOCOL_FILE_UNTRACKED", `${PROTOCOL_FILE} must be tracked in Git.`, PROTOCOL_FILE);
  }
  const source = fs.readFileSync(protocolPath, "utf8");
  const yaml = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
    schema: "core",
  });
  if (yaml.errors.length || yaml.warnings.length) {
    const problem = yaml.errors[0] ?? yaml.warnings[0];
    throw new HyWorkflowError("PROTOCOL_YAML_INVALID", `Invalid ${PROTOCOL_FILE}: ${problem.message}`, PROTOCOL_FILE);
  }
  let aliasFound = false;
  visit(yaml, { Alias: () => { aliasFound = true; } });
  if (aliasFound) {
    throw new HyWorkflowError("PROTOCOL_YAML_ALIAS_FORBIDDEN", `${PROTOCOL_FILE} must not use YAML aliases.`, PROTOCOL_FILE);
  }
  const raw = yaml.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isJsonObject(raw)) throw new HyWorkflowError("PROTOCOL_ROOT_INVALID", `${PROTOCOL_FILE} must contain one object.`);
  exactKeys(raw, ["schema", "obligations"], PROTOCOL_FILE);
  if (raw.schema !== "hy-workflow.protocol.v1") {
    throw new HyWorkflowError("PROTOCOL_SCHEMA_UNSUPPORTED", "Protocol schema must be hy-workflow.protocol.v1.");
  }
  if (!Array.isArray(raw.obligations) || raw.obligations.length > 512) {
    throw new HyWorkflowError("PROTOCOL_OBLIGATIONS_INVALID", "obligations must be an array with at most 512 entries.");
  }
  const obligations = raw.obligations.map(obligationFrom);
  const ids = obligations.map(item => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new HyWorkflowError("PROTOCOL_ID_DUPLICATE", "Every obligation id must be unique.");
  }
  assertSupersessionGraph(obligations);
  for (const sourcePath of [...new Set(obligations.flatMap(item => item.sources))].sort()) assertSource(root, sourcePath);
  return {
    path: protocolPath,
    hash: createHash("sha256").update(source).digest("hex"),
    document: { schema: "hy-workflow.protocol.v1", obligations },
  };
}
