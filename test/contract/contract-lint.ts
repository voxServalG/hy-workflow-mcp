import { runContractLint } from "../../src/contralint/run.js";

const report = runContractLint(process.cwd());
if (!report.ok) {
  throw new Error("contract lint failed: " + JSON.stringify(report.findings, null, 2));
}
console.log(`contract-lint: ${report.status} with ${report.counts.warning} warning(s)`);
