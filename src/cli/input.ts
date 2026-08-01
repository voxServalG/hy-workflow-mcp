import * as fs from "node:fs";
import * as path from "node:path";

export class CliInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliInputError";
    this.code = code;
  }
}
export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonValue(value: unknown, location: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new CliInputError("INPUT_JSON_NON_FINITE", `${location} contains a non-finite number.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${location}[${index}]`));
    return;
  }
  if (isJsonObject(value)) {
    for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${location}.${key}`);
    return;
  }
  throw new CliInputError("INPUT_JSON_UNSUPPORTED_VALUE", `${location} is not a JSON value.`);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isJsonObject(value)) return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = canonicalJsonValue(value[key]);
  return result;
}

export function stableJsonStringify(value: unknown): string {
  assertJsonValue(value, "JSON value");
  return JSON.stringify(canonicalJsonValue(value));
}

function parseJsonObject(source: string, label: string, maxBytes: number): JsonObject {
  if (Buffer.byteLength(source, "utf8") > maxBytes) {
    throw new CliInputError("INPUT_TOO_LARGE", `${label} exceeds ${maxBytes} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new CliInputError(
      "INPUT_JSON_INVALID",
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isJsonObject(parsed)) {
    throw new CliInputError("INPUT_JSON_NOT_OBJECT", `${label} must contain one JSON object.`);
  }
  assertJsonValue(parsed, label);
  return parsed;
}

function readRegularFile(file: string, cwd: string, maxBytes: number): string {
  const resolved = path.resolve(cwd, file);
  let initial: fs.Stats;
  try {
    initial = fs.lstatSync(resolved);
  } catch (error) {
    throw new CliInputError(
      "INPUT_FILE_UNREADABLE",
      `Input file cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new CliInputError("INPUT_FILE_UNSAFE", "Input file must be a regular file, not a symbolic link.");
  }
  if (initial.size > maxBytes) {
    throw new CliInputError("INPUT_TOO_LARGE", `Input file exceeds ${maxBytes} bytes.`);
  }

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes
      || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw new CliInputError("INPUT_FILE_UNSAFE", "Input file changed or became unsafe while it was opened.");
    }
    const content = fs.readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new CliInputError("INPUT_TOO_LARGE", `Input file exceeds ${maxBytes} bytes.`);
    }
    return content;
  } catch (error) {
    if (error instanceof CliInputError) throw error;
    throw new CliInputError(
      "INPUT_FILE_UNREADABLE",
      `Input file cannot be read safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function parseInputOptions(
  argv: readonly string[],
  options: { cwd?: string; maxBytes?: number } = {},
): JsonObject {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  let inline: string | undefined;
  let inputFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--json") continue;
    if (option !== "--input" && option !== "--input-file") {
      throw new CliInputError("OPTION_UNKNOWN", `Unknown option: ${option}.`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new CliInputError("OPTION_VALUE_MISSING", `${option} requires one value.`);
    if (option === "--input") {
      if (inline !== undefined) throw new CliInputError("OPTION_REPEATED", "--input may be provided once.");
      inline = value;
    } else {
      if (inputFile !== undefined) throw new CliInputError("OPTION_REPEATED", "--input-file may be provided once.");
      inputFile = value;
    }
    index += 1;
  }
  if (inline !== undefined && inputFile !== undefined) {
    throw new CliInputError("INPUT_SOURCE_CONFLICT", "Use either --input or --input-file, not both.");
  }
  if (inline === undefined && inputFile === undefined) {
    throw new CliInputError("INPUT_REQUIRED", "verify requires --input or --input-file.");
  }
  const source = inline ?? readRegularFile(inputFile!, options.cwd ?? process.cwd(), maxBytes);
  return parseJsonObject(source, inline === undefined ? "Input file" : "--input", maxBytes);
}
