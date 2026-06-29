import { runContractLint } from "../../src/contralint/run.js";

const report = runContractLint(process.cwd());
const relevant = report.findings.filter(finding => finding.rule === "output" || finding.rule === "errors");
if (relevant.length > 0) {
  throw new Error("output/errors contract lint failed: " + JSON.stringify(relevant, null, 2));
}
