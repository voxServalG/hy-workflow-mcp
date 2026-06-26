import {
  DISPLAY_FIELDS,
  META_FIELDS,
  NOTICE_FIELDS,
  NOTICE_UPDATE_FIELDS,
  OUTPUT_CONTROL_FIELDS,
  PAGINATION_FIELDS,
  RECOVERY_FIELDS,
} from "../../output/contract.js";
import { exists, readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const OUTPUT_DOCS = [
  "docs/output.md",
  "docs/tool-result-envelope.md",
  "docs/state-machine.md",
  "docs/skills/core/SKILL.md",
];

function addMissingTokenFindings(findings: ContractFinding[], rule: string, severity: ContractFinding["severity"], fields: readonly string[], text: string, file: string, label: string): void {
  for (const field of fields) {
    if (!text.includes(field)) {
      findings.push({ rule, severity, message: label + " omits " + field + ".", file });
    }
  }
}

export function checkOutputContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  if (!exists(context.root, "src/output/contract.ts")) {
    findings.push({ rule: "output", severity: "hard_fail", message: "Missing canonical output contract field module.", file: "src/output/contract.ts" });
    return findings;
  }
  if (!exists(context.root, "src/output/envelope.ts")) {
    findings.push({ rule: "output", severity: "hard_fail", message: "Missing canonical output envelope module.", file: "src/output/envelope.ts" });
    return findings;
  }
  const contract = readText(context.root, "src/output/contract.ts");
  const source = readText(context.root, "src/output/envelope.ts");
  const base = readText(context.root, "src/tools/_base.ts");
  const docs = OUTPUT_DOCS.map(file => readText(context.root, file)).join("\n");
  if (!base.includes("../output/envelope.js")) {
    findings.push({ rule: "output", severity: "hard_fail", message: "Tool base helper must delegate to src/output/envelope.ts.", file: "src/tools/_base.ts" });
  }
  addMissingTokenFindings(findings, "output", "hard_fail", OUTPUT_CONTROL_FIELDS, contract, "src/output/contract.ts", "Output contract source");
  addMissingTokenFindings(findings, "output", "hard_fail", OUTPUT_CONTROL_FIELDS, source, "src/output/envelope.ts", "Envelope source");
  addMissingTokenFindings(findings, "output", "amend_required", OUTPUT_CONTROL_FIELDS, docs, "docs/output.md", "Envelope docs");
  addMissingTokenFindings(findings, "output", "hard_fail", DISPLAY_FIELDS, source, "src/output/envelope.ts", "Display source");
  addMissingTokenFindings(findings, "output", "amend_required", DISPLAY_FIELDS, docs, "docs/output.md", "Display docs");
  addMissingTokenFindings(findings, "output", "hard_fail", RECOVERY_FIELDS, source, "src/output/envelope.ts", "Recovery source");
  addMissingTokenFindings(findings, "output", "amend_required", RECOVERY_FIELDS, docs, "docs/output.md", "Recovery docs");
  addMissingTokenFindings(findings, "output", "hard_fail", PAGINATION_FIELDS, source, "src/output/envelope.ts", "Pagination source");
  addMissingTokenFindings(findings, "output", "amend_required", PAGINATION_FIELDS, docs, "docs/output.md", "Pagination docs");
  addMissingTokenFindings(findings, "output", "hard_fail", META_FIELDS, source, "src/output/envelope.ts", "Meta source");
  addMissingTokenFindings(findings, "output", "amend_required", META_FIELDS, docs, "docs/output.md", "Meta docs");
  addMissingTokenFindings(findings, "output", "hard_fail", NOTICE_FIELDS, source, "src/output/envelope.ts", "Notice source");
  addMissingTokenFindings(findings, "output", "amend_required", NOTICE_FIELDS, docs, "docs/output.md", "Notice docs");
  addMissingTokenFindings(findings, "output", "hard_fail", NOTICE_UPDATE_FIELDS, source, "src/output/envelope.ts", "Notice update source");
  addMissingTokenFindings(findings, "output", "amend_required", NOTICE_UPDATE_FIELDS, docs, "docs/output.md", "Notice update docs");
  return findings;
}
