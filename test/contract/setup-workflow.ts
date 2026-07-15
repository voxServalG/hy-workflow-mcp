import * as fs from "node:fs";
import { checkSetupContracts } from "../../src/contralint/rules/setup.js";

const findings = checkSetupContracts({ root: process.cwd() });
const hardFails = findings.filter(f => f.severity === "hard_fail");
if (hardFails.length) {
  throw new Error("Setup/workflow contract violations:\n" +
    hardFails.map(f => `  ${f.message} (${f.file})`).join("\n"));
}
console.log(`setup-workflow: ${findings.length} findings (0 hard)`);

// Shared mode deploys the packaged template verbatim; default mode does not write it.
const template = fs.readFileSync("templates/hy-workflow.yml", "utf-8");
const yaml = fs.readFileSync(".github/workflows/hy-workflow.yml", "utf-8");
if (template !== yaml) throw new Error("checked-in workflow must match templates/hy-workflow.yml exactly");
if (fs.existsSync("setup") || fs.existsSync("setup.ps1")) throw new Error("legacy platform installers must not exist");
if (yaml.includes('"setup"') || yaml.includes('"setup.ps1"')) throw new Error("workflow filters must not reference removed installers");

console.log("setup-workflow: packaged shared template is canonical");
