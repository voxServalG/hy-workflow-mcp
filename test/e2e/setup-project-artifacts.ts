import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeSetup } from "../../src/setup/operations.js";
import { readDeployment } from "../../src/runtime/deployment.js";
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
const options: SetupOptions = { action: "setup", mode: "shared", clients: ["claude"], language: "zh", yes: true, dryRun: false, json: true, removeGlobal: false };
const expectedFiles = ".github/workflows/hy-workflow.yml,hy-workflow.json";

const dryRoot = makeGitProject("hy-project-artifacts-dry-");
const dryBefore = gitStatus(dryRoot);
const dryClient = new MemoryClient();
const dry = await executeSetup(dryRoot, { ...options, dryRun: true }, [dryClient]);
assert(dry.projectFilesChanged.sort().join(",") === expectedFiles, "dry-run should report both planned team artifacts");
assert(gitStatus(dryRoot) === dryBefore && dryClient.values.size === 0, "dry-run must not write project files or MCP client definitions");

const root = makeGitProject("hy-project-artifacts-fresh-");
const client = new MemoryClient();
const setup = await executeSetup(root, options, [client]);
assert(setup.projectFilesChanged.sort().join(",") === expectedFiles, "fresh setup should write exactly config and workflow");
assert(fs.existsSync(path.join(root, "hy-workflow.json")) && fs.existsSync(path.join(root, ".github", "workflows", "hy-workflow.yml")), "fresh setup should materialize both team artifacts");
assert(readDeployment(root)?.mode === "shared" && readDeployment(root)?.projectFiles.sort().join(",") === expectedFiles, "fresh setup should register both artifacts as shared deployment files");

const firstStatus = gitStatus(root);
const repeated = await executeSetup(root, options, [client]);
assert(repeated.projectFilesChanged.length === 0 && repeated.message.includes("already current"), "repeated setup should be idempotent");
assert(gitStatus(root) === firstStatus, "repeated setup must not create project drift");

const unset = await executeSetup(root, { ...options, action: "unset", removeGlobal: true }, [client]);
assert(unset.projectFilesChanged.length === 0 && unset.message.includes("shared project files kept"), "unset should explicitly retain team artifacts");
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
const upgraded = await executeSetup(cloneRoot, options, [cloneClient]);
assert(upgraded.projectFilesChanged.join(",") === ".github/workflows/hy-workflow.yml", "a new clone without local deployment state should still upgrade the committed workflow");
assert(JSON.parse(fs.readFileSync(path.join(cloneRoot, "hy-workflow.json"), "utf-8")).teamMetadata.owner === "docs", "setup should preserve unknown team config fields");
assert(fs.readFileSync(path.join(cloneRoot, ".github", "workflows", "hy-workflow.yml"), "utf-8") === fs.readFileSync(path.resolve("templates/hy-workflow.yml"), "utf-8"), "setup should refresh the shared workflow from the packaged template");

console.log("setup-project-artifacts: fresh, dry-run, repeat, clone upgrade, and unset contracts pass");
