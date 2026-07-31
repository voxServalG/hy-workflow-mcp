import * as fs from "node:fs";
import * as path from "node:path";
import { validateToolCallArguments } from "../output/control.js";
import type {
  ParsedWorkflowCli,
  WorkflowCliCommand,
  WorkflowCliInput,
} from "./workflow.js";

type CliErrorType = "validation" | "io";
type CliErrorSubtype = "invalid_arguments" | "invalid_command" | "io_failure";

export class WorkflowCliInputError extends Error {
  readonly type: CliErrorType;
  readonly subtype: CliErrorSubtype;
  readonly code: string;
  readonly retryable = false;

  constructor(
    code: string,
    message: string,
    options: { type?: CliErrorType; subtype?: CliErrorSubtype } = {},
  ) {
    super(message);
    this.name = "WorkflowCliInputError";
    this.type = options.type ?? "validation";
    this.subtype = options.subtype ?? "invalid_arguments";
    this.code = code;
  }
}

export type WorkflowCliInputDependencies = {
  maxInputBytes: number;
  isCommand: (value: string) => value is WorkflowCliCommand;
  commandSpec: (command: WorkflowCliCommand) => {
    tool: string;
    fields: readonly string[];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertJsonValue(value: unknown, location: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new WorkflowCliInputError("INPUT_JSON_NON_FINITE", `${location} contains a non-finite number.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${location}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${location}.${key}`);
    return;
  }
  throw new WorkflowCliInputError("INPUT_JSON_UNSUPPORTED_VALUE", `${location} contains a value that JSON cannot represent.`);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = canonicalJsonValue(value[key]);
  return result;
}

export function stableJsonStringify(value: unknown): string {
  assertJsonValue(value, "JSON value");
  return JSON.stringify(canonicalJsonValue(value));
}

function parseInputJson(source: string, label: string, maxInputBytes: number): WorkflowCliInput {
  if (Buffer.byteLength(source, "utf-8") > maxInputBytes) {
    throw new WorkflowCliInputError("INPUT_TOO_LARGE", `${label} exceeds ${maxInputBytes} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: any) {
    throw new WorkflowCliInputError("INPUT_JSON_INVALID", `${label} is not valid JSON: ${error?.message ?? String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new WorkflowCliInputError("INPUT_JSON_NOT_OBJECT", `${label} must contain one JSON object.`);
  }
  assertJsonValue(parsed, label);
  return parsed;
}

function readInputFile(file: string, cwd: string, maxInputBytes: number): string {
  const resolved = path.resolve(cwd, file);
  let info: fs.Stats;
  try {
    info = fs.lstatSync(resolved);
  } catch (error: any) {
    throw new WorkflowCliInputError(
      "INPUT_FILE_UNREADABLE",
      `Input file cannot be inspected: ${error?.message ?? String(error)}`,
      { type: "io", subtype: "io_failure" },
    );
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new WorkflowCliInputError("INPUT_FILE_UNSAFE", "Input file must be a regular file and must not be a symbolic link.");
  }
  if (info.size > maxInputBytes) {
    throw new WorkflowCliInputError("INPUT_TOO_LARGE", `Input file exceeds ${maxInputBytes} bytes.`);
  }

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxInputBytes) {
      throw new WorkflowCliInputError("INPUT_FILE_UNSAFE", "Input file must remain a regular file within the size limit.");
    }
    const content = fs.readFileSync(descriptor, "utf-8");
    if (Buffer.byteLength(content, "utf-8") > maxInputBytes) {
      throw new WorkflowCliInputError("INPUT_TOO_LARGE", `Input file exceeds ${maxInputBytes} bytes.`);
    }
    return content;
  } catch (error: any) {
    if (error instanceof WorkflowCliInputError) throw error;
    throw new WorkflowCliInputError(
      "INPUT_FILE_UNREADABLE",
      `Input file cannot be read safely: ${error?.message ?? String(error)}`,
      { type: "io", subtype: "io_failure" },
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function rethrowInputValidation(command: WorkflowCliCommand, tool: string, error: unknown): never {
  if (error instanceof WorkflowCliInputError) throw error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage
    .replace("Invalid nextAction contract: ", "")
    .split(tool).join(command);
  throw new WorkflowCliInputError("INPUT_SCHEMA_INVALID", message);
}

function validateOptionalString(input: WorkflowCliInput, field: string, command: WorkflowCliCommand): void {
  if (input[field] !== undefined && typeof input[field] !== "string") {
    throw new WorkflowCliInputError("INPUT_SCHEMA_INVALID", `${command} input.${field} must be a string when provided.`);
  }
}

function validateExamSubmitResults(input: WorkflowCliInput): void {
  if (!Array.isArray(input.results)) return;
  const allowed = new Set(["id", "command", "nonce", "exitCode", "durationMs", "stdoutTail", "stderrTail"]);
  for (const [index, value] of input.results.entries()) {
    if (!isRecord(value)) {
      throw new WorkflowCliInputError("INPUT_SCHEMA_INVALID", `exam-submit input.results[${index}] must be an object.`);
    }
    const unknown = Object.keys(value).filter(field => !allowed.has(field)).sort();
    if (unknown.length) {
      throw new WorkflowCliInputError(
        "INPUT_UNKNOWN_FIELDS",
        `exam-submit input.results[${index}] does not accept fields: ${unknown.join(", ")}.`,
      );
    }
    for (const field of ["id", "command", "nonce"] as const) {
      if (typeof value[field] !== "string" || !value[field].trim()) {
        throw new WorkflowCliInputError("INPUT_SCHEMA_INVALID", `exam-submit input.results[${index}].${field} must be a non-empty string.`);
      }
    }
    if (!Number.isInteger(value.exitCode)) {
      throw new WorkflowCliInputError("INPUT_SCHEMA_INVALID", `exam-submit input.results[${index}].exitCode must be an integer.`);
    }
    if (value.durationMs !== undefined && !Number.isInteger(value.durationMs)) {
      throw new WorkflowCliInputError("INPUT_SCHEMA_INVALID", `exam-submit input.results[${index}].durationMs must be an integer when provided.`);
    }
    for (const field of ["stdoutTail", "stderrTail"] as const) {
      if (value[field] !== undefined && typeof value[field] !== "string") {
        throw new WorkflowCliInputError("INPUT_SCHEMA_INVALID", `exam-submit input.results[${index}].${field} must be a string when provided.`);
      }
    }
  }
}

export function validateWorkflowCommandInputWithDependencies(
  command: WorkflowCliCommand,
  input: WorkflowCliInput,
  dependencies: WorkflowCliInputDependencies,
): void {
  if (!isRecord(input)) {
    throw new WorkflowCliInputError("INPUT_JSON_NOT_OBJECT", `${command} input must be one JSON object.`);
  }
  assertJsonValue(input, `${command} input`);
  const spec = dependencies.commandSpec(command);
  const allowed = new Set(spec.fields);
  const unknown = Object.keys(input).filter(field => !allowed.has(field)).sort();
  if (unknown.length) {
    throw new WorkflowCliInputError("INPUT_UNKNOWN_FIELDS", `${command} does not accept input fields: ${unknown.join(", ")}.`);
  }
  try {
    validateToolCallArguments(spec.tool, input);
    if (command === "approve") {
      validateOptionalString(input, "note", command);
      validateOptionalString(input, "auditDecision", command);
      if (input.auditDecision !== undefined && input.auditDecision !== "continue" && input.auditDecision !== "replan") {
        throw new WorkflowCliInputError("INPUT_SCHEMA_INVALID", "approve input.auditDecision must be continue or replan.");
      }
    }
    if (command === "amend-plan") validateOptionalString(input, "note", command);
    if (command === "exam-submit") validateExamSubmitResults(input);
  } catch (error) {
    rethrowInputValidation(command, spec.tool, error);
  }
}

export function parseWorkflowCliArgsWithDependencies(
  argv: readonly string[],
  options: { cwd?: string },
  dependencies: WorkflowCliInputDependencies,
): ParsedWorkflowCli {
  const rawCommand = argv[0];
  if (!rawCommand) {
    throw new WorkflowCliInputError("COMMAND_MISSING", "A workflow command is required.", { subtype: "invalid_command" });
  }
  if (!dependencies.isCommand(rawCommand)) {
    throw new WorkflowCliInputError("COMMAND_UNKNOWN", `Unknown workflow command: ${rawCommand}.`, { subtype: "invalid_command" });
  }

  let inline: string | undefined;
  let inputFile: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--input" && option !== "--input-file") {
      throw new WorkflowCliInputError("OPTION_UNKNOWN", `Unknown ${rawCommand} option: ${option}.`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new WorkflowCliInputError("OPTION_VALUE_MISSING", `${option} requires one value.`);
    }
    if (option === "--input") {
      if (inline !== undefined) throw new WorkflowCliInputError("OPTION_REPEATED", "--input may be provided only once.");
      inline = value;
    } else {
      if (inputFile !== undefined) throw new WorkflowCliInputError("OPTION_REPEATED", "--input-file may be provided only once.");
      inputFile = value;
    }
    index += 1;
  }
  if (inline !== undefined && inputFile !== undefined) {
    throw new WorkflowCliInputError("INPUT_SOURCE_CONFLICT", "Use either --input or --input-file, not both.");
  }

  const inputSource = inline !== undefined ? "inline" : inputFile !== undefined ? "file" : "default";
  const source = inline ?? (inputFile !== undefined
    ? readInputFile(inputFile, options.cwd ?? process.cwd(), dependencies.maxInputBytes)
    : "{}");
  const input = parseInputJson(source, inputSource === "file" ? "Input file" : "--input", dependencies.maxInputBytes);
  validateWorkflowCommandInputWithDependencies(rawCommand, input, dependencies);
  return { command: rawCommand, input, argv: [...argv], inputSource };
}
