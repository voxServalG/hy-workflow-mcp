import { ERROR_SUBTYPES, ERROR_TYPES } from "../../errs/catalog.js";
import { ERROR_ENVELOPE_FIELDS } from "../../output/contract.js";
import { exists, readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const REQUIRED_TYPES = ["validation", "workflow_state", "scope", "docs", "verification", "config", "setup", "io", "internal"];
const MERGE_RECOVERY_CODES = [
  "MERGE_LOCK_BUSY",
  "PR_MERGE_OUTCOME_UNCONFIRMED",
  "POST_MERGE_SYNC_INCOMPLETE",
] as const;

export function checkErrorContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  for (const type of REQUIRED_TYPES) {
    if (!(ERROR_TYPES as readonly string[]).includes(type)) {
      findings.push({ rule: "errors", severity: "hard_fail", message: "Missing required error type " + type + ".", file: "src/errs/catalog.ts" });
    }
  }
  const docs = readText(context.root, "docs/errors.md");
  const mergeProduction = [
    readText(context.root, "src/git.ts"),
    readText(context.root, "src/tools/merge.ts"),
  ].join("\n");
  for (const code of MERGE_RECOVERY_CODES) {
    if (!mergeProduction.includes(code)) {
      findings.push({
        rule: "errors",
        severity: "hard_fail",
        message: `Merge recovery implementation omits stable error code ${code}.`,
        file: "src/git.ts",
      });
    }
    if (!docs.includes(code)) {
      findings.push({
        rule: "errors",
        severity: "amend_required",
        message: `Merge recovery error code ${code} is not documented.`,
        file: "docs/errors.md",
      });
    }
  }
  for (const subtype of ERROR_SUBTYPES) {
    if (!docs.includes(subtype)) {
      findings.push({ rule: "errors", severity: "amend_required", message: "Error subtype " + subtype + " is not documented.", file: "docs/errors.md" });
    }
  }
  const contract = readText(context.root, "src/output/contract.ts");
  const source = readText(context.root, "src/errs/structured.ts");
  const envelopeDocs = docs + "\n" + readText(context.root, "docs/output.md") + "\n" + readText(context.root, "docs/tool-result-envelope.md");
  for (const field of ERROR_ENVELOPE_FIELDS) {
    if (!contract.includes(field)) {
      findings.push({ rule: "errors", severity: "hard_fail", message: "Error envelope contract omits " + field + ".", file: "src/output/contract.ts" });
    }
    if (!source.includes(field)) {
      findings.push({ rule: "errors", severity: "hard_fail", message: "StructuredError type omits " + field + ".", file: "src/errs/structured.ts" });
    }
    if (!envelopeDocs.includes(field)) {
      findings.push({ rule: "errors", severity: "amend_required", message: "Error envelope docs omit " + field + ".", file: "docs/errors.md" });
    }
  }
  const cliPath = "src/cli/workflow.ts";
  if (!exists(context.root, cliPath)) {
    findings.push({ rule: "errors", severity: "hard_fail", message: "Workflow CLI error adapter is missing.", file: cliPath });
  } else {
    const cli = readText(context.root, cliPath);
    for (const token of ["structuredError(caught)", "failureEnvelope", "errorWithoutHint", "INPUT_SCHEMA_INVALID"]) {
      if (!cli.includes(token)) {
        findings.push({ rule: "errors", severity: "hard_fail", message: `Workflow CLI error envelope is missing ${token}.`, file: cliPath });
      }
    }
    if (cli.includes("JSON.stringify({ error:") || cli.includes("throw new Error(JSON.stringify")) {
      findings.push({ rule: "errors", severity: "hard_fail", message: "Workflow CLI must not expose a bare string/object error outside the versioned envelope.", file: cliPath });
    }
  }
  return findings;
}
