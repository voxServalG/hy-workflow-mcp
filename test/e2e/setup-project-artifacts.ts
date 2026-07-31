import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRuntimeConfig, withConfirmedCiCommands } from "../../src/config.js";
import { executeSetup } from "../../src/setup/operations.js";
import { readDeployment } from "../../src/runtime/deployment.js";
import { renderWorkflowTemplate } from "../../src/setup/shared.js";
import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { gitStatus, makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

class MemoryClient implements ClientAdapter {
  name = "claude" as const;
  values = new Map<ServerName, McpDefinition>();
  detect() { return { name: this.name, installed: true, executable: "claude", version: "test", configured: [...this.values.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot { return { definition: this.values.get(server) ?? null }; }
  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot {
    const before = this.inspect(server);
    this.values.set(server, definition);
    return before;
  }
  remove(server: ServerName, _expected: McpDefinition, previous?: ClientServerSnapshot | null): void {
    if (previous?.definition) this.values.set(server, previous.definition);
    else this.values.delete(server);
  }
}

useRuntimeHome("hy-project-artifacts-runtime-");
const options: SetupOptions = { action: "setup", mode: "shared", clients: ["claude"], language: "zh", yes: true, dryRun: false, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };
const expectedFiles = ".github/workflows/hy-workflow.yml,hy-workflow.json";

const dryRoot = makeGitProject("hy-project-artifacts-dry-");
const dryBefore = gitStatus(dryRoot);
const dryClient = new MemoryClient();
const dry = await executeSetup(dryRoot, { ...options, dryRun: true }, [dryClient]);
assert(dry.projectFilesChanged.sort().join(",") === expectedFiles, "dry-run should report only the two minimal project files");
assert(gitStatus(dryRoot) === dryBefore && dryClient.values.size === 0, "dry-run must not write project files or MCP client definitions");

const root = makeGitProject("hy-project-artifacts-fresh-");
const client = new MemoryClient();
const setup = await executeSetup(root, options, [client]);
assert(setup.projectFilesChanged.sort().join(",") === expectedFiles, "fresh setup should write only config and the thin workflow");
assert(setup.phase === "setup" && setup.action === "setup" && setup.stage === "setup.apply" && setup.status === "completed", "direct executeSetup must return the typed setup success contract");
assert(setup.nextAction.tool === null && setup.nextAction.stage === setup.stage && setup.control.stop && setup.userAction === null, "direct executeSetup success must be terminal and machine routable");
assert(fs.existsSync(path.join(root, "hy-workflow.json")) && fs.existsSync(path.join(root, ".github", "workflows", "hy-workflow.yml")) && !fs.existsSync(path.join(root, "AGENTS.md")), "fresh setup must not inject AGENTS.md");
assert(readDeployment(root)?.mode === "shared" && readDeployment(root)?.projectFiles.sort().join(",") === expectedFiles, "fresh setup should register only the minimal project surface");

const firstStatus = gitStatus(root);
const repeated = await executeSetup(root, options, [client]);
assert(repeated.projectFilesChanged.length === 0 && repeated.message.includes("already current"), "repeated setup should be idempotent");
assert(gitStatus(root) === firstStatus, "repeated setup must not create project drift");

const unset = await executeSetup(root, { ...options, action: "unset", removeGlobal: true }, [client]);
assert(unset.projectFilesChanged.length === 0 && unset.message.includes("shared project files kept"), "unset should explicitly retain team artifacts");
assert(unset.phase === "setup" && unset.action === "unset" && unset.stage === "setup.unset" && unset.status === "completed", "direct unset must return the typed success contract");
assert(gitStatus(root) === firstStatus, "unset must leave shared config and workflow unchanged");

const cloneRoot = makeGitProject("hy-project-artifacts-clone-");
const config = JSON.parse(fs.readFileSync(path.join(root, "hy-workflow.json"), "utf-8"));
config.teamMetadata = { owner: "docs" };
fs.writeFileSync(path.join(cloneRoot, "hy-workflow.json"), JSON.stringify(config, null, 2) + "\n", "utf-8");
fs.mkdirSync(path.join(cloneRoot, ".github", "workflows"), { recursive: true });
fs.writeFileSync(path.join(cloneRoot, ".github", "workflows", "hy-workflow.yml"), "name: stale hy-workflow\n", "utf-8");
execFileSync("git", ["add", "hy-workflow.json", ".github/workflows/hy-workflow.yml"], { cwd: cloneRoot });
execFileSync("git", ["commit", "-m", "team setup"], { cwd: cloneRoot, stdio: "ignore" });
const cloneClient = new MemoryClient();
const clonePreview = await executeSetup(cloneRoot, { ...options, dryRun: true }, [cloneClient]);
assert(clonePreview.artifactChanges?.length === 0, "clone preview must not open or hash unmarked project artifacts");
const cloneConfigBefore = fs.readFileSync(path.join(cloneRoot, "hy-workflow.json"), "utf-8");
const cloneWorkflowBefore = fs.readFileSync(path.join(cloneRoot, ".github", "workflows", "hy-workflow.yml"), "utf-8");
const upgraded = await executeSetup(cloneRoot, options, [cloneClient]);
assert(upgraded.projectFilesChanged.length === 0 && !readDeployment(cloneRoot)?.projectContract, "ordinary clone setup must use external-only authority without claiming project files");
assert(fs.readFileSync(path.join(cloneRoot, "hy-workflow.json"), "utf-8") === cloneConfigBefore, "ordinary clone setup must preserve orphan root config bytes");
assert(fs.readFileSync(path.join(cloneRoot, ".github", "workflows", "hy-workflow.yml"), "utf-8") === cloneWorkflowBefore, "ordinary clone setup must preserve orphan workflow bytes");
assert(!fs.existsSync(path.join(cloneRoot, "AGENTS.md")), "setup must never create AGENTS.md on a new clone");

const explicitCloneRoot = makeGitProject("hy-project-artifacts-explicit-clone-");
fs.writeFileSync(path.join(explicitCloneRoot, "hy-workflow.json"), cloneConfigBefore);
fs.mkdirSync(path.join(explicitCloneRoot, ".github", "workflows"), { recursive: true });
fs.writeFileSync(path.join(explicitCloneRoot, ".github", "workflows", "hy-workflow.yml"), cloneWorkflowBefore);
const detectedExplicitCandidate = resolveRuntimeConfig(explicitCloneRoot).config;
const standardExplicitCandidate = {
  ...detectedExplicitCandidate,
  policy: { ...(detectedExplicitCandidate.policy ?? {}), profile: "standard" },
};
const explicitCandidate = options.ciCommands?.length
  ? withConfirmedCiCommands(standardExplicitCandidate, options.ciCommands)
  : standardExplicitCandidate;
assert(Boolean(explicitCandidate), "explicit clone sync must have a detected candidate");
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const explicitReview = [
  {
    file: "hy-workflow.json",
    beforeHash: hash(cloneConfigBefore),
    afterHash: hash(JSON.stringify(explicitCandidate, null, 2) + "\n"),
  },
  {
    file: ".github/workflows/hy-workflow.yml",
    beforeHash: hash(cloneWorkflowBefore),
    afterHash: hash(renderWorkflowTemplate()),
  },
];
const explicitCloneClient = cloneClient;
const explicitUpgrade = await executeSetup(explicitCloneRoot, { ...options, syncProjectArtifacts: true, acceptArtifactChanges: true, reviewedArtifactChanges: explicitReview }, [explicitCloneClient]);
assert(explicitUpgrade.projectFilesChanged.sort().join(",") === ".github/workflows/hy-workflow.yml,hy-workflow.json", "complete external review must allow explicit minimal artifact sync");
assert(readDeployment(explicitCloneRoot)?.projectContract === "minimal-v1", "explicit clone sync must establish exact new integration authority");
assert(fs.readFileSync(path.join(explicitCloneRoot, ".github", "workflows", "hy-workflow.yml"), "utf-8") === renderWorkflowTemplate(), "explicit sync should refresh the workflow from the deterministic packaged template render");

if (process.platform !== "win32") {
  const symlinkRoot = makeGitProject("hy-project-artifacts-link-");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hy-project-artifacts-outside-"));
  fs.symlinkSync(outside, path.join(symlinkRoot, ".github"), "dir");
  const linkClient = new MemoryClient();
  let linkCode = "";
  try { await executeSetup(symlinkRoot, options, [linkClient]); } catch (error: any) { linkCode = error?.code; }
  assert(linkCode === "SETUP_PROJECT_PATH_UNSAFE", "setup must reject a shared-artifact parent symlink");
  assert(fs.readdirSync(outside).length === 0 && linkClient.values.size === 0, "rejected artifact symlink must not write outside the project or mutate clients");
}

console.log("setup-project-artifacts: fresh, dry-run, repeat, clone upgrade, and unset contracts pass");
