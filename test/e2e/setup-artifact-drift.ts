import * as fs from "node:fs";
import * as path from "node:path";
import { checkSetupStamp, createSetupGate } from "../../src/bootstrap.js";
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

let code = "";
try { await executeSetup(root, options, [client]); } catch (error: any) { code = error?.code; }
assert(code === "SETUP_ARTIFACT_DRIFT", "new setup must not overwrite an existing project file without exact review");
assert(fs.readFileSync(workflow, "utf-8") === "name: project-owned workflow\n", "blocked new setup must preserve the project file");

const preview = await executeSetup(root, { ...options, dryRun: true }, [client]);
const review = preview.artifactChanges?.filter(item => item.requiresAcceptance).map(({ file, beforeHash, afterHash }) => ({ file, beforeHash, afterHash }));
const applied = await executeSetup(root, { ...options, acceptArtifactChanges: true, reviewedArtifactChanges: review }, [client]);
assert(applied.ok && applied.projectFilesChanged.includes(".github/workflows/hy-workflow.yml"), "exactly reviewed new integration should apply");

fs.writeFileSync(path.join(root, "hy-workflow.json"), "{\"projectOwnedEdit\":true}\n");
fs.writeFileSync(workflow, "name: project-owned edit after setup\n");
assert(checkSetupStamp(root).status === "current", "project-owned config/workflow edits must not create runtime drift");
assert(createSetupGate(root)() === null, "project-owned edits must not block plan/edit/verify tools");

useRuntimeHome("hy-artifact-review-race-runtime-");
const raceRoot = makeGitProject("hy-artifact-review-race-");
const raceWorkflow = path.join(raceRoot, ".github", "workflows", "hy-workflow.yml");
fs.mkdirSync(path.dirname(raceWorkflow), { recursive: true });
fs.writeFileSync(raceWorkflow, "name: reviewed-A\n");
const raceClient = new Client();
const racePreview = await executeSetup(raceRoot, { ...options, dryRun: true }, [raceClient]);
const raceReview = racePreview.artifactChanges?.filter(item => item.requiresAcceptance).map(({ file, beforeHash, afterHash }) => ({ file, beforeHash, afterHash }));
const restore = setSetupTestHooks({ beforeLockedPreflight: () => fs.writeFileSync(raceWorkflow, "name: concurrent-B\n") });
let raceCode = "";
try { await executeSetup(raceRoot, { ...options, acceptArtifactChanges: true, reviewedArtifactChanges: raceReview }, [raceClient]); }
catch (error: any) { raceCode = error?.code; }
finally { restore(); }
assert(raceCode === "SETUP_ARTIFACT_DRIFT", "new-install review must be rebound when bytes change before the lock");
assert(fs.readFileSync(raceWorkflow, "utf-8") === "name: concurrent-B\n", "stale review must preserve the concurrent project edit");

console.log("setup-artifact-drift: new-install review is strict; runtime project drift is non-blocking");
