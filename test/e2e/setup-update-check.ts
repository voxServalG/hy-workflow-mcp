import * as fs from "node:fs";
import * as path from "node:path";
import { checkSetupStamp, createSetupGate, setupStampPath } from "../../src/bootstrap.js";
import { writeDeployment } from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { gitStatus, makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function legacyDeployment(root: string, version = "2025.01.01.0"): void {
  writeDeployment(root, {
    setupVersion: version,
    mode: "shared",
    clients: [],
    projectFiles: ["hy-workflow.json", ".github/workflows/hy-workflow.yml", "AGENTS.md"],
    tools: {},
    artifacts: {
      "hy-workflow.json": { sha256: "0".repeat(64), size: 1 },
      ".github/workflows/hy-workflow.yml": { sha256: "1".repeat(64), size: 1 },
      "AGENTS.md": { sha256: "2".repeat(64), size: 1 },
    },
  });
}

useRuntimeHome("hy-update-check-legacy-");
const root = makeGitProject("hy-update-check-legacy-");
fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
fs.writeFileSync(path.join(root, "hy-workflow.json"), "{ invalid legacy injection\n");
fs.writeFileSync(path.join(root, ".github", "workflows", "hy-workflow.yml"), "old injected workflow\n");
fs.writeFileSync(path.join(root, "AGENTS.md"), "old injected rules\n");
legacyDeployment(root);

let check = checkSetupStamp(root);
assert(check.status === "current" && check.compatibility === "legacy-inert", `old setup version must remain silently current: ${JSON.stringify(check)}`);
assert(createSetupGate(root)() === null, "old deployment must not block normal workflow tools");

fs.writeFileSync(path.join(root, "hy-workflow.json"), "changed legacy config\n");
fs.rmSync(path.join(root, ".github", "workflows", "hy-workflow.yml"));
fs.writeFileSync(path.join(root, "AGENTS.md"), "changed legacy rules\n");
const changedStatus = gitStatus(root);
check = checkSetupStamp(root);
assert(check.status === "current", "changed or missing legacy injection bytes must be completely irrelevant");
assert(check.artifactDrift === undefined, "runtime setup check must never emit artifact drift");
assert(gitStatus(root) === changedStatus, "runtime setup check must not dirty the worktree");

const deploymentPath = projectPaths(root).deployment;
const schema2 = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
schema2.schemaVersion = "2";
delete schema2.tools;
delete schema2.artifacts;
fs.writeFileSync(deploymentPath, JSON.stringify(schema2, null, 2) + "\n");
check = checkSetupStamp(root);
assert(check.status === "current" && check.compatibility === "legacy-inert", "schema 2 external deployment must remain compatible without migration");

const unsafe = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
unsafe.identity.root = path.join(root, "different-project");
fs.writeFileSync(deploymentPath, JSON.stringify(unsafe, null, 2) + "\n");
check = checkSetupStamp(root);
assert(check.status === "unreadable", "project identity mismatch must remain a real safety block");
assert(createSetupGate(root)()?.error?.code === "SETUP_UPDATE_REQUIRED", "unsafe external identity must return typed setup recovery");

useRuntimeHome("hy-update-check-missing-");
const missingRoot = makeGitProject("hy-update-check-missing-");
check = checkSetupStamp(missingRoot);
assert(check.status === "missing_stamp" && check.stampPath === setupStampPath(missingRoot), "a genuinely missing external deployment still requires setup");

console.log("setup-update-check: old versions and injections are silent; only external identity can block");
