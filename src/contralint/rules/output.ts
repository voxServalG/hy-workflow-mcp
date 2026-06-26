import { exists, readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const REQUIRED_FIELDS = ["ok", "phase", "next", "display", "hint", "requires_user", "stop_here", "allowedTools", "blockedTools", "recovery"];

export function checkOutputContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  if (!exists(context.root, "src/output/envelope.ts")) {
    findings.push({ rule: "output", severity: "hard_fail", message: "Missing canonical output envelope module.", file: "src/output/envelope.ts" });
    return findings;
  }
  const source = readText(context.root, "src/output/envelope.ts");
  const base = readText(context.root, "src/tools/_base.ts");
  const docs = readText(context.root, "docs/output.md") + "\\n" + readText(context.root, "docs/tool-result-envelope.md");
  if (!base.includes("../output/envelope.js")) {
    findings.push({ rule: "output", severity: "hard_fail", message: "Tool base helper must delegate to src/output/envelope.ts.", file: "src/tools/_base.ts" });
  }
  for (const field of REQUIRED_FIELDS) {
    if (!source.includes(field)) findings.push({ rule: "output", severity: "hard_fail", message: "Envelope source omits " + field + ".", file: "src/output/envelope.ts" });
    if (!docs.includes(field)) findings.push({ rule: "output", severity: "amend_required", message: "Envelope docs omit " + field + ".", file: "docs/output.md" });
  }
  return findings;
}

