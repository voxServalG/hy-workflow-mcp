import { PHASES, VALID_TRANSITIONS } from "../../runtime/state-machine.js";
import { readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

export function checkWorkflowContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const state = readText(context.root, "src/state.ts");
  const docs = readText(context.root, "docs/state-machine.md");
  const tick = String.fromCharCode(96);
  if (!state.includes("./runtime/state-machine.js")) {
    findings.push({ rule: "workflow", severity: "hard_fail", message: "src/state.ts must consume canonical runtime state-machine constants.", file: "src/state.ts" });
  }
  for (const phase of PHASES) {
    if (!docs.includes(tick + phase + tick)) {
      findings.push({ rule: "workflow", severity: "hard_fail", message: "Phase " + phase + " is missing from docs/state-machine.md.", file: "docs/state-machine.md" });
    }
  }
  for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
    for (const to of targets) {
      if (!docs.includes(from) || !docs.includes(to)) {
        findings.push({ rule: "workflow", severity: "amend_required", message: "Transition " + from + " -> " + to + " is not clearly documented.", file: "docs/state-machine.md" });
      }
    }
  }
  return findings;
}

