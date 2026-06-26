import { checkModuleContracts } from "../../src/contralint/rules/modules.js";

const findings = checkModuleContracts({ root: process.cwd() });
const hardFails = findings.filter(f => f.severity === "hard_fail");
if (hardFails.length) {
  throw new Error("Module boundary contract violations:\n" +
    hardFails.map(f => `  ${f.message} (${f.file})`).join("\n"));
}
console.log(`module-boundary: ${findings.length} findings (0 hard)`);
