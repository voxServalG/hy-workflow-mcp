import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { checkSetupStamp, createSetupGate } from "../../src/bootstrap.js";
import { ensureConfigDefaults } from "../../src/config.js";
import { readDeployment } from "../../src/runtime/deployment.js";
import { executeSetup } from "../../src/setup/operations.js";
import { renderWorkflowTemplate } from "../../src/setup/shared.js";
import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";
import { setSetupTestHooks } from "../helpers/setup-hooks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class Client implements ClientAdapter {
  name = "claude" as const;
  values = new Map<ServerName, McpDefinition>();
  detect() { return { name: this.name, installed: true, executable: "claude", version: "test", configured: [...this.values.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot { return { definition: this.values.get(server) ?? null }; }
  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot { const previous = this.inspect(server); this.values.set(server, definition); return previous; }
  remove(server: ServerName, _expected: McpDefinition, previous?: ClientServerSnapshot | null) { if (previous?.definition) this.values.set(server, previous.definition); else this.values.delete(server); }
}

const options: SetupOptions = { action: "setup", mode: "shared", clients: ["claude"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false };
useRuntimeHome("hy-artifact-review-runtime-");
const root = makeGitProject("hy-artifact-review-");
const workflow = path.join(root, ".github", "workflows", "hy-workflow.yml");
fs.mkdirSync(path.dirname(workflow), { recursive: true });
fs.writeFileSync(workflow, "name: project-owned workflow\n");
const client = new Client();

const preview = await executeSetup(root, { ...options, dryRun: true }, [client]);
assert(preview.artifactChanges?.length === 0, "ordinary setup preview must not open or hash an orphan project artifact");
const applied = await executeSetup(root, options, [client]);
assert(applied.ok && applied.projectFilesChanged.length === 0, "ordinary setup must succeed in external-only mode without an artifact gate");
assert(applied.projectFileDisposition === "external-only" && applied.configAuthority === "external", "ordinary setup must report external-only authority plainly");
assert(fs.readFileSync(workflow, "utf-8") === "name: project-owned workflow\n", "external-only setup must preserve the orphan project file");
assert(!readDeployment(root)?.projectContract && readDeployment(root)?.projectFiles.length === 0, "external-only setup must not claim or hash the orphan project surface");

fs.writeFileSync(path.join(root, "hy-workflow.json"), "{\"projectOwnedEdit\":true}\n");
fs.writeFileSync(workflow, "name: project-owned edit after setup\n");
assert(checkSetupStamp(root).status === "current", "project-owned config/workflow edits must not create runtime drift");
assert(createSetupGate(root)() === null, "project-owned edits must not block plan/edit/verify tools");

useRuntimeHome("hy-artifact-review-zero-contact-runtime-");
const zeroContactRoot = makeGitProject("hy-artifact-review-zero-contact-");
fs.mkdirSync(path.join(zeroContactRoot, "hy-workflow.json"));
fs.mkdirSync(path.join(zeroContactRoot, ".github", "workflows", "hy-workflow.yml"), { recursive: true });
const inertReview = [{ file: "hy-workflow.json", beforeHash: "a".repeat(64), afterHash: "b".repeat(64) }];
const zeroContact = await executeSetup(zeroContactRoot, {
  ...options,
  acceptArtifactChanges: true,
  reviewedArtifactChanges: inertReview,
}, [new Client()]);
assert(zeroContact.ok && zeroContact.projectFileDisposition === "external-only", "accept/review without explicit sync intent must remain ordinary zero-contact setup");
assert(fs.statSync(path.join(zeroContactRoot, "hy-workflow.json")).isDirectory(), "ordinary setup must not open or replace an occupied config target");
assert(fs.statSync(path.join(zeroContactRoot, ".github", "workflows", "hy-workflow.yml")).isDirectory(), "ordinary setup must not open or replace an occupied workflow target");

useRuntimeHome("hy-artifact-review-explicit-runtime-");
const explicitRoot = makeGitProject("hy-artifact-review-explicit-");
const explicitWorkflow = path.join(explicitRoot, ".github", "workflows", "hy-workflow.yml");
fs.mkdirSync(path.dirname(explicitWorkflow), { recursive: true });
fs.writeFileSync(explicitWorkflow, "name: explicitly-reviewed-A\n");
const explicitCandidate = ensureConfigDefaults(explicitRoot, { dryRun: true }).candidate;
assert(Boolean(explicitCandidate), "explicit sync fixture must have a detected config candidate");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const explicitReview = [{
  file: ".github/workflows/hy-workflow.yml",
  beforeHash: sha(fs.readFileSync(explicitWorkflow)),
  afterHash: sha(renderWorkflowTemplate()),
}];
const explicitClient = new Client();
const explicit = await executeSetup(explicitRoot, { ...options, syncProjectArtifacts: true, acceptArtifactChanges: true, reviewedArtifactChanges: explicitReview }, [explicitClient]);
assert(explicit.ok && explicit.projectFilesChanged.sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "complete exact review must allow an independent minimal-v1 artifact sync");
assert(explicit.projectFileDisposition === "explicit-sync" && explicit.configAuthority === "project", "explicit sync must report the new project authority");
assert(readDeployment(explicitRoot)?.projectContract === "minimal-v1", "explicit exact sync must establish the new project authority marker");

useRuntimeHome("hy-artifact-review-race-runtime-");
const raceRoot = makeGitProject("hy-artifact-review-race-");
const raceWorkflow = path.join(raceRoot, ".github", "workflows", "hy-workflow.yml");
fs.mkdirSync(path.dirname(raceWorkflow), { recursive: true });
fs.writeFileSync(raceWorkflow, "name: reviewed-A\n");
const raceClient = new Client();
const raceReview = [{
  file: ".github/workflows/hy-workflow.yml",
  beforeHash: sha(fs.readFileSync(raceWorkflow)),
  afterHash: sha(renderWorkflowTemplate()),
}];
const restore = setSetupTestHooks({ beforeLockedPreflight: () => fs.writeFileSync(raceWorkflow, "name: concurrent-B\n") });
let raceCode = "";
try { await executeSetup(raceRoot, { ...options, syncProjectArtifacts: true, acceptArtifactChanges: true, reviewedArtifactChanges: raceReview }, [raceClient]); }
catch (error: any) { raceCode = error?.code; }
finally { restore(); }
assert(raceCode === "SETUP_ARTIFACT_DRIFT", "new-install review must be rebound when bytes change before the lock");
assert(fs.readFileSync(raceWorkflow, "utf-8") === "name: concurrent-B\n", "stale review must preserve the concurrent project edit");

console.log("setup-artifact-drift: orphan defaults are zero-contact; explicit exact sync is strict");
