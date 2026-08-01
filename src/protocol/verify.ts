import { createHash } from "node:crypto";
import { isJsonObject, stableJsonStringify, type JsonObject } from "../cli/input.js";
import { HyWorkflowError, issueFromError, type CliIssue } from "../cli/output.js";
import { inspectRepository } from "./inspect.js";
import type { InspectionBinding, InspectionEnvelope, IssuedCommand } from "./types.js";

export type SubmittedResult = {
  commandId: string;
  argv: string[];
  startedAt: string;
  completedAt: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type VerificationEnvelope = {
  schema: "hy-workflow.verify.v1";
  version: 1;
  command: "verify";
  ok: boolean;
  status: "verified" | "failed" | "missing" | "stale" | "invalid" | "unavailable";
  trust: "agent_attested";
  binding: {
    submitted: InspectionBinding | null;
    current: InspectionBinding | null;
    matches: boolean;
  };
  summary: {
    expected: number;
    submitted: number;
    passed: number;
    failed: number;
    missing: number;
  };
  results: Array<{
    commandId: string;
    obligationIds: string[];
    expectedExitCode: number;
    exitCode: number;
    status: "passed" | "failed";
    startedAt: string;
    completedAt: string;
    durationMs: number;
    stdout: { bytes: number; sha256: string };
    stderr: { bytes: number; sha256: string };
  }>;
  missingCommandIds: string[];
  issues: CliIssue[];
};

type Evidence = {
  binding: InspectionBinding;
  results: SubmittedResult[];
};

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key)).sort();
  if (unknown.length) {
    throw new HyWorkflowError("EVIDENCE_UNKNOWN_FIELDS", `${label} contains unknown fields: ${unknown.join(", ")}.`);
  }
}
function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new HyWorkflowError("EVIDENCE_BINDING_INVALID", `${label} must be a lowercase SHA-256 hex string.`);
  }
  return value;
}

function bindingFrom(value: unknown): InspectionBinding {
  if (!isJsonObject(value)) throw new HyWorkflowError("EVIDENCE_BINDING_INVALID", "binding must be an object.");
  exactKeys(value, ["issuanceId", "head", "diffHash", "protocolHash"], "binding");
  const head = value.head;
  if (typeof head !== "string" || !/^[0-9a-f]{40,64}$/.test(head)) {
    throw new HyWorkflowError("EVIDENCE_BINDING_INVALID", "binding.head must be a Git object id.");
  }
  return {
    issuanceId: requiredHash(value.issuanceId, "binding.issuanceId"),
    head,
    diffHash: requiredHash(value.diffHash, "binding.diffHash"),
    protocolHash: requiredHash(value.protocolHash, "binding.protocolHash"),
  };
}

function timestamp(value: unknown, label: string): { value: string; milliseconds: number } {
  if (typeof value !== "string") throw new HyWorkflowError("EVIDENCE_TIME_INVALID", `${label} must be an ISO timestamp.`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new HyWorkflowError("EVIDENCE_TIME_INVALID", `${label} must use canonical ISO-8601 UTC form.`);
  }
  return { value, milliseconds };
}

function resultFrom(value: unknown, index: number): SubmittedResult {
  const label = `results[${index}]`;
  if (!isJsonObject(value)) throw new HyWorkflowError("EVIDENCE_RESULT_INVALID", `${label} must be an object.`);
  exactKeys(value, ["commandId", "argv", "startedAt", "completedAt", "exitCode", "stdout", "stderr"], label);
  if (typeof value.commandId !== "string" || !/^cmd-[0-9a-f]{20}$/.test(value.commandId)) {
    throw new HyWorkflowError("EVIDENCE_RESULT_INVALID", `${label}.commandId is invalid.`);
  }
  if (!Array.isArray(value.argv) || value.argv.length < 1 || value.argv.length > 32
    || value.argv.some(argument => typeof argument !== "string")) {
    throw new HyWorkflowError("EVIDENCE_RESULT_INVALID", `${label}.argv must be a non-empty string array.`);
  }
  const argv = value.argv as string[];
  if (!Number.isInteger(value.exitCode) || Number(value.exitCode) < -255 || Number(value.exitCode) > 255) {
    throw new HyWorkflowError("EVIDENCE_RESULT_INVALID", `${label}.exitCode must be an integer from -255 to 255.`);
  }
  if (typeof value.stdout !== "string" || typeof value.stderr !== "string") {
    throw new HyWorkflowError("EVIDENCE_RESULT_INVALID", `${label}.stdout and stderr must be strings.`);
  }
  const started = timestamp(value.startedAt, `${label}.startedAt`);
  const completed = timestamp(value.completedAt, `${label}.completedAt`);
  if (completed.milliseconds < started.milliseconds || completed.milliseconds - started.milliseconds > 86_400_000) {
    throw new HyWorkflowError("EVIDENCE_TIME_INVALID", `${label} has an invalid execution interval.`);
  }
  return {
    commandId: value.commandId,
    argv: [...argv],
    startedAt: started.value,
    completedAt: completed.value,
    exitCode: Number(value.exitCode),
    stdout: value.stdout,
    stderr: value.stderr,
  };
}

function parseEvidence(input: JsonObject): Evidence {
  exactKeys(input, ["schema", "binding", "results"], "evidence");
  if (input.schema !== "hy-workflow.evidence.v1") {
    throw new HyWorkflowError("EVIDENCE_SCHEMA_UNSUPPORTED", "evidence.schema must be hy-workflow.evidence.v1.");
  }
  if (!Array.isArray(input.results) || input.results.length > 4096) {
    throw new HyWorkflowError("EVIDENCE_RESULTS_INVALID", "evidence.results must be an array with at most 4096 entries.");
  }
  const results = input.results.map(resultFrom);
  const ids = results.map(result => result.commandId);
  if (new Set(ids).size !== ids.length) {
    throw new HyWorkflowError("EVIDENCE_RESULT_DUPLICATE", "Each commandId may appear only once in evidence.results.");
  }
  return { binding: bindingFrom(input.binding), results };
}

function baseEnvelope(
  status: VerificationEnvelope["status"],
  submitted: InspectionBinding | null,
  current: InspectionBinding | null,
  issues: CliIssue[],
): VerificationEnvelope {
  return {
    schema: "hy-workflow.verify.v1",
    version: 1,
    command: "verify",
    ok: status !== "invalid",
    status,
    trust: "agent_attested",
    binding: { submitted, current, matches: false },
    summary: { expected: 0, submitted: 0, passed: 0, failed: 0, missing: 0 },
    results: [],
    missingCommandIds: [],
    issues,
  };
}

function bindingDifferences(submitted: InspectionBinding, current: InspectionBinding): CliIssue[] {
  const fields: Array<keyof InspectionBinding> = ["issuanceId", "head", "diffHash", "protocolHash"];
  return fields.filter(field => submitted[field] !== current[field]).map(field => ({
    code: `EVIDENCE_${field.replace(/[A-Z]/g, character => `_${character}`).toUpperCase()}_STALE`,
    message: `Submitted ${field} does not match the current repository inspection.`,
  }));
}

function commandMap(commands: IssuedCommand[]): Map<string, IssuedCommand> {
  return new Map(commands.map(command => [command.commandId, command]));
}

export function verifyEvidence(input: JsonObject, cwd = process.cwd()): VerificationEnvelope {
  let evidence: Evidence;
  try {
    evidence = parseEvidence(input);
  } catch (error) {
    return baseEnvelope("invalid", null, null, [issueFromError(error)]);
  }

  const inspection: InspectionEnvelope = inspectRepository(cwd);
  if (!inspection.binding || inspection.status === "invalid" || inspection.status === "unavailable") {
    const envelope = baseEnvelope("unavailable", evidence.binding, null, inspection.issues);
    envelope.summary.submitted = evidence.results.length;
    return envelope;
  }
  const differences = bindingDifferences(evidence.binding, inspection.binding);
  if (differences.length) {
    const envelope = baseEnvelope("stale", evidence.binding, inspection.binding, differences);
    envelope.summary = {
      expected: inspection.commands.length,
      submitted: evidence.results.length,
      passed: 0,
      failed: 0,
      missing: inspection.commands.length,
    };
    envelope.missingCommandIds = inspection.commands.map(command => command.commandId).sort();
    return envelope;
  }

  const expected = commandMap(inspection.commands);
  const unexpected = evidence.results.filter(result => !expected.has(result.commandId)).map(result => result.commandId).sort();
  if (unexpected.length) {
    const envelope = baseEnvelope("invalid", evidence.binding, inspection.binding, [{
      code: "EVIDENCE_COMMAND_UNEXPECTED",
      message: `Evidence contains commands that were not issued: ${unexpected.join(", ")}.`,
    }]);
    envelope.binding.matches = true;
    envelope.summary = { expected: expected.size, submitted: evidence.results.length, passed: 0, failed: 0, missing: expected.size };
    return envelope;
  }

  const argvMismatch = evidence.results.find(result => {
    const command = expected.get(result.commandId)!;
    return stableJsonStringify(result.argv) !== stableJsonStringify(command.argv);
  });
  if (argvMismatch) {
    const envelope = baseEnvelope("invalid", evidence.binding, inspection.binding, [{
      code: "EVIDENCE_ARGV_MISMATCH",
      message: `Evidence argv does not exactly match issued command ${argvMismatch.commandId}.`,
    }]);
    envelope.binding.matches = true;
    envelope.summary = { expected: expected.size, submitted: evidence.results.length, passed: 0, failed: 0, missing: expected.size };
    return envelope;
  }

  const resultsById = new Map(evidence.results.map(result => [result.commandId, result]));
  const missingCommandIds = [...expected.keys()].filter(commandId => !resultsById.has(commandId)).sort();
  const checked = evidence.results.map(result => {
    const command = expected.get(result.commandId)!;
    const passed = result.exitCode === command.expectedExitCode;
    return {
      commandId: result.commandId,
      obligationIds: [...command.obligationIds],
      expectedExitCode: command.expectedExitCode,
      exitCode: result.exitCode,
      status: passed ? "passed" as const : "failed" as const,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      durationMs: Date.parse(result.completedAt) - Date.parse(result.startedAt),
      stdout: { bytes: Buffer.byteLength(result.stdout, "utf8"), sha256: hashValue(result.stdout) },
      stderr: { bytes: Buffer.byteLength(result.stderr, "utf8"), sha256: hashValue(result.stderr) },
    };
  }).sort((left, right) => left.commandId.localeCompare(right.commandId));
  const failed = checked.filter(result => result.status === "failed").length;
  const status: VerificationEnvelope["status"] = missingCommandIds.length ? "missing" : failed ? "failed" : "verified";
  return {
    schema: "hy-workflow.verify.v1",
    version: 1,
    command: "verify",
    ok: true,
    status,
    trust: "agent_attested",
    binding: { submitted: evidence.binding, current: inspection.binding, matches: true },
    summary: {
      expected: expected.size,
      submitted: evidence.results.length,
      passed: checked.length - failed,
      failed,
      missing: missingCommandIds.length,
    },
    results: checked,
    missingCommandIds,
    issues: status === "verified" ? [] : [{
      code: status === "missing" ? "EVIDENCE_COMMANDS_MISSING" : "EVIDENCE_COMMANDS_FAILED",
      message: status === "missing"
        ? "Not every issued command has one submitted result."
        : "At least one command exit code differs from its expected exit code.",
    }],
  };
}
