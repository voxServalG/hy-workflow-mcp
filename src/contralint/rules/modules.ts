import type { ContractFinding, ContractRuleContext } from "../types.js";
import { readText } from "../files.js";

const MODULE_BOUNDARIES: Record<string, string[]> = {
  "src/errs/": ["catalog.ts", "structured.ts"],
  "src/contralint/": ["index.ts", "run.ts", "types.ts", "files.ts"],
  "src/log/": ["index.ts"],
  "src/npm/": ["package.ts"],
  "src/output/": ["envelope.ts"],
};

export function checkModuleContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];

  for (const [dir, expectedFiles] of Object.entries(MODULE_BOUNDARIES)) {
    for (const f of expectedFiles) {
      try {
        readText(context.root, dir + f);
      } catch {
        findings.push({
          rule: "modules",
          severity: "hard_fail",
          message: `Required module file missing: ${dir}${f}`,
          file: dir + f,
        });
      }
    }
  }

  // Module directory existence is verified by the per-file check above

  return findings;
}
