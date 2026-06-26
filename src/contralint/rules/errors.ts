import { ERROR_SUBTYPES, ERROR_TYPES } from "../../errs/catalog.js";
import { readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const REQUIRED_TYPES = ["validation", "workflow_state", "scope", "docs", "verification", "config", "io", "internal"];

export function checkErrorContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  for (const type of REQUIRED_TYPES) {
    if (!(ERROR_TYPES as readonly string[]).includes(type)) {
      findings.push({ rule: "errors", severity: "hard_fail", message: "Missing required error type " + type + ".", file: "src/errs/catalog.ts" });
    }
  }
  const docs = readText(context.root, "docs/errors.md");
  for (const subtype of ERROR_SUBTYPES) {
    if (!docs.includes(subtype)) {
      findings.push({ rule: "errors", severity: "amend_required", message: "Error subtype " + subtype + " is not documented.", file: "docs/errors.md" });
    }
  }
  const server = readText(context.root, "src/server.ts");
  if (server.includes("JSON.stringify({ error: message }")) {
    findings.push({ rule: "errors", severity: "hard_fail", message: "Server catch block returns a bare error string instead of a structured envelope.", file: "src/server.ts" });
  }
  return findings;
}

