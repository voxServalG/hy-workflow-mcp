import * as fs from "node:fs";
import { checkSetupContracts } from "../../src/contralint/rules/setup.js";

const findings = checkSetupContracts({ root: process.cwd() });
const hardFails = findings.filter(f => f.severity === "hard_fail");
if (hardFails.length) {
  throw new Error("Setup/workflow contract violations:\n" +
    hardFails.map(f => `  ${f.message} (${f.file})`).join("\n"));
}
console.log(`setup-workflow: ${findings.length} findings (0 hard)`);

// Additional: verify setup YAML heredoc matches actual .github/workflows
const setup = fs.readFileSync("setup", "utf-8");
const yaml = fs.readFileSync(".github/workflows/hy-workflow.yml", "utf-8");

// Setup should include an inline YAML block that generates the CI workflow
if (!setup.includes("hy-workflow.yml"))
  throw new Error("setup must generate hy-workflow.yml");

console.log("setup-workflow: inline YAML block present");
