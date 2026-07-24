import * as fs from "node:fs";
import * as path from "node:path";
import { trackedFiles } from "../../git.js";
import { isLocalArtifact, TRACKED_PROJECT_ARTIFACTS } from "../../policy/artifacts.js";
import { readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

export function checkArtifactContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const tracked = trackedFiles(context.root);
  for (const file of tracked.filter(isLocalArtifact)) {
    if (!fs.existsSync(path.join(context.root, file))) continue;
    findings.push({ rule: "artifacts", severity: "hard_fail", message: "Local or runtime artifact is tracked: " + file + ".", file });
  }
  if (tracked.some(f => f.startsWith("dist/"))) {
    findings.push({ rule: "artifacts", severity: "hard_fail", message: "Generated build output must not be tracked: dist/", file: ".gitignore" });
  }
  const ignore = readText(context.root, ".gitignore");
  if (!ignore.includes("dist/") && !ignore.includes("dist")) {
    findings.push({ rule: "artifacts", severity: "hard_fail", message: ".gitignore does not ignore generated dist/ output.", file: ".gitignore" });
  }
  const readme = readText(context.root, "README.md");
  for (const artifact of TRACKED_PROJECT_ARTIFACTS) {
    if (!readme.includes(artifact)) {
      findings.push({ rule: "artifacts", severity: "warning", message: "README does not mention tracked artifact " + artifact + ".", file: "README.md" });
    }
  }
  return findings;
}
