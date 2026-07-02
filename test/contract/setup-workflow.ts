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
const setupPs1 = fs.readFileSync("setup.ps1", "utf-8");
const yaml = fs.readFileSync(".github/workflows/hy-workflow.yml", "utf-8");

// Setup should include an inline YAML block that generates the CI workflow
if (!setup.includes("hy-workflow.yml"))
  throw new Error("setup must generate hy-workflow.yml");
if (!setup.includes("     - .hy/"))
  throw new Error("setup prompt must list .hy/ as a local runtime artifact");
if (!setup.includes('"setup.ps1"') || !yaml.includes('"setup.ps1"'))
  throw new Error("setup and workflow path filters must include setup.ps1");
if (setupPs1.includes("hy-harness"))
  throw new Error("setup.ps1 must not call hy-harness; it must delegate to the canonical setup script");

console.log("setup-workflow: inline YAML block present");
