import * as fs from "node:fs";
import * as path from "node:path";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { executeSetup } from "../../src/setup/operations.js";
import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";
import { setSetupTestHooks } from "../helpers/setup-hooks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class Client implements ClientAdapter {
  name = "claude" as const;
  values = new Map<ServerName, McpDefinition>();
  onInspect: (() => void) | null = null;
  detect() { return { name: this.name, installed: true, executable: "claude", version: "test", configured: [...this.values.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot { this.onInspect?.(); return { definition: this.values.get(server) ?? null }; }
  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot { const previous = this.inspect(server); this.values.set(server, definition); return previous; }
  remove(server: ServerName, _expected: McpDefinition, previous?: ClientServerSnapshot | null) { if (previous?.definition) this.values.set(server, previous.definition); else this.values.delete(server); }
}

useRuntimeHome("hy-artifact-drift-runtime-");
const root = makeGitProject("hy-artifact-drift-");
fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
fs.writeFileSync(path.join(root, ".github", "workflows", "hy-workflow.yml"), "name: custom-team-workflow\n");
const client = new Client();
const options: SetupOptions = { action: "setup", mode: "shared", clients: ["claude"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };

let code = "";
try { await executeSetup(root, options, [client]); } catch (error: any) { code = error?.code; }
assert(code === "SETUP_ARTIFACT_DRIFT", "existing unmanaged workflow must require explicit acceptance");
assert(fs.readFileSync(path.join(root, ".github", "workflows", "hy-workflow.yml"), "utf-8").includes("custom-team-workflow"), "blocked setup must not overwrite the workflow");

const dry = await executeSetup(root, { ...options, dryRun: true }, [client]);
const change = dry.artifactChanges?.find(item => item.file === ".github/workflows/hy-workflow.yml");
assert(change?.changeKind === "unmanaged_existing" && change.beforeHash && change.afterHash && change.diff.includes("custom-team-workflow"), "dry-run must expose change kind, hashes, and bounded diff");
assert(client.values.size === 0, "dry-run must not write client definitions");

const reviewedArtifactChanges = dry.artifactChanges?.filter(item => item.requiresAcceptance).map(({ file, beforeHash, afterHash }) => ({ file, beforeHash, afterHash }));
const applied = await executeSetup(root, { ...options, acceptArtifactChanges: true, reviewedArtifactChanges }, [client]);
assert(applied.ok && applied.projectFilesChanged.includes(".github/workflows/hy-workflow.yml"), "reviewed artifact change should apply");

useRuntimeHome("hy-artifact-review-race-runtime-");
const raceRoot = makeGitProject("hy-artifact-review-race-");
fs.mkdirSync(path.join(raceRoot, ".github", "workflows"), { recursive: true });
const raceWorkflow = path.join(raceRoot, ".github", "workflows", "hy-workflow.yml");
fs.writeFileSync(raceWorkflow, "name: reviewed-A\n");
const raceClient = new Client();
const racePreview = await executeSetup(raceRoot, { ...options, dryRun: true }, [raceClient]);
const raceReview = racePreview.artifactChanges?.filter(item => item.requiresAcceptance).map(({ file, beforeHash, afterHash }) => ({ file, beforeHash, afterHash }));
const restoreRaceHook = setSetupTestHooks({ beforeLockedPreflight: () => fs.writeFileSync(raceWorkflow, "name: concurrent-B\n") });
let raceCode = "";
try { await executeSetup(raceRoot, { ...options, acceptArtifactChanges: true, reviewedArtifactChanges: raceReview }, [raceClient]); }
catch (error: any) { raceCode = error?.code; }
finally { restoreRaceHook(); }
assert(raceCode === "SETUP_ARTIFACT_DRIFT", "artifact acceptance must be rebound if content changes after the displayed preview");
assert(fs.readFileSync(raceWorkflow, "utf-8") === "name: concurrent-B\n" && raceClient.values.size === 0, "stale artifact acceptance must preserve the concurrent edit and client state");

const staleAgents = "<!-- hy-workflow-rules -->\n<!-- hy-workflow-rules-version: 2000.01.01.1 -->\nstale\n<!-- /hy-workflow-rules -->\n";
useRuntimeHome("hy-readiness-lock-race-runtime-");
const readinessRoot = makeGitProject("hy-readiness-lock-race-");
const readinessClient = new Client();
const invalidLiveConfig = JSON.stringify({
  project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "missing-docs" },
  codelint: { lintDirs: ["src"], maxLines: 500 },
  doclint: { maxLines: 200 },
  docsGardener: { catalogs: {} },
  ci: { commands: ["npm ci", "npm run build", "npm run test"] },
}, null, 2) + "\n";
const restoreReadinessHook = setSetupTestHooks({ afterSetupPreflightBeforeLock: root => fs.writeFileSync(path.join(root, "hy-workflow.json"), invalidLiveConfig) });
let readinessCode = "";
try { await executeSetup(readinessRoot, options, [readinessClient]); }
catch (error: any) { readinessCode = error?.code; }
finally { restoreReadinessHook(); }
assert(readinessCode === "SETUP_PREFLIGHT_FAILED", "project readiness drift after preview but before the setup lock must fail closed");
assert(readinessClient.values.size === 0 && fs.readFileSync(path.join(readinessRoot, "hy-workflow.json"), "utf-8") === invalidLiveConfig && !fs.existsSync(projectPaths(readinessRoot).deployment), "locked readiness rejection must preserve the live config edit and occur before the first setup mutation");

useRuntimeHome("hy-readiness-postcondition-runtime-");
const postconditionRoot = makeGitProject("hy-readiness-postcondition-");
const postconditionClient = new Client();
let readinessInjected = false;
postconditionClient.onInspect = () => {
  if (readinessInjected || !fs.existsSync(projectPaths(postconditionRoot).deployment)) return;
  readinessInjected = true;
  fs.writeFileSync(path.join(postconditionRoot, "AGENTS.md"), staleAgents);
};
let postconditionCode = "";
try { await executeSetup(postconditionRoot, options, [postconditionClient]); }
catch (error: any) { postconditionCode = error?.code; }
assert(readinessInjected && postconditionCode === "SETUP_PREFLIGHT_FAILED", "final postcondition must catch project readiness drift after setup writes");
assert(postconditionClient.values.size === 0 && !fs.existsSync(path.join(postconditionRoot, "hy-workflow.json")) && !fs.existsSync(projectPaths(postconditionRoot).deployment), "final readiness failure must roll back setup-owned mutations while preserving the external readiness edit");
assert(fs.readFileSync(path.join(postconditionRoot, "AGENTS.md"), "utf-8") === staleAgents, "readiness rollback must preserve the concurrent AGENTS edit");

console.log("setup-artifact-drift: exact review hashes plus locked/final readiness TOCTOU rejection pass");
