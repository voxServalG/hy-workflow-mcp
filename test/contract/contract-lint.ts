import { runContractLint } from "../../src/lint-contract/run.js";

const report = runContractLint(process.cwd());
if (!report.ok) {
  throw new Error("contract lint should pass for this repository: " + JSON.stringify(report.findings, null, 2));
}
if (report.status !== "passed" && report.status !== "warning") {
  throw new Error("unexpected contract lint status " + report.status);
}

