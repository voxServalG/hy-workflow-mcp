import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSetupDoctor } from "../../src/setup/doctor.js";
import { executeSetup } from "../../src/setup/operations.js";
import { projectPaths, projectStoragePaths } from "../../src/runtime/user-paths.js";
import type { ClientName } from "../../src/runtime/deployment.js";
import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";
import { setSetupTestHooks } from "../helpers/setup-hooks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class Client implements ClientAdapter {
  constructor(readonly name: ClientName = "claude") {}
  values = new Map<ServerName, McpDefinition>();
  detect() { return { name: this.name, installed: true, executable: "claude", version: "test", configured: [...this.values.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot { return { definition: this.values.get(server) ?? null }; }
  install(server: ServerName, definition: McpDefinition): ClientServerSnapshot { const before = this.inspect(server); this.values.set(server, definition); return before; }
  remove(server: ServerName, _expected: McpDefinition, previous?: ClientServerSnapshot | null) { if (previous?.definition) this.values.set(server, previous.definition); else this.values.delete(server); }
}

if (process.platform !== "win32") {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hy-doctor-bin-"));
  for (const command of ["hy-workflow", "docs-gardener", "codex"]) fs.writeFileSync(path.join(bin, command), "#!/bin/sh\necho test-version\n", { mode: 0o755 });
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  const restoreHooks = setSetupTestHooks({ skipHandshake: true });
  const install = async (prefix: string, name?: ClientName) => {
    useRuntimeHome(`hy-doctor-${prefix}-runtime-`);
    delete process.env.CODEX_HOME;
    const root = makeGitProject(`hy-doctor-${prefix}-`);
    const client = name ? new Client(name) : null;
    const options: SetupOptions = { action: "setup", mode: "shared", clients: name ? [name] : [], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };
    await executeSetup(root, options, client ? [client] : [], { inspectDirectTools: true });
    return root;
  };

  const root = await install("healthy");
  const healthy = await runSetupDoctor(root, { offline: true });
  assert(healthy.ok && healthy.checks.some(item => item.id === "deployment" && item.status === "pass"), "doctor should verify schema3 deployment and direct tools");
  fs.writeFileSync(path.join(root, ".github", "workflows", "hy-workflow.yml"), "name: drifted\n");
  const drifted = await runSetupDoctor(root, { offline: true });
  assert(!drifted.ok && drifted.checks.some(item => item.id.includes("artifact..github") && item.status === "fail"), "doctor must fail on team workflow hash drift");

  const registryMissingRoot = await install("registry-missing");
  fs.rmSync(projectPaths(registryMissingRoot).registry);
  const registryMissing = await runSetupDoctor(registryMissingRoot, { offline: true });
  assert(!registryMissing.ok && registryMissing.checks.some(item => item.id === "coherence.registry" && item.status === "fail"), "schema3 deployment without a registry record must fail doctor");

  const registryDriftRoot = await install("registry-drift", "claude");
  const registryPath = projectPaths(registryDriftRoot).registry;
  const registryValue = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  registryValue.projects[projectPaths(registryDriftRoot).identity.id].clients = [];
  fs.writeFileSync(registryPath, JSON.stringify(registryValue, null, 2) + "\n");
  const registryDrift = await runSetupDoctor(registryDriftRoot, { offline: true });
  assert(!registryDrift.ok && registryDrift.checks.some(item => item.id === "coherence.registry" && item.status === "fail"), "registry client drift must fail doctor");

  const ownershipMissingRoot = await install("ownership-missing", "claude");
  fs.rmSync(projectPaths(ownershipMissingRoot).clientOwnership);
  const ownershipMissing = await runSetupDoctor(ownershipMissingRoot, { offline: true });
  assert(!ownershipMissing.ok && ownershipMissing.checks.some(item => item.id === "coherence.ownership" && item.status === "fail"), "schema3 deployment without ownership evidence must fail doctor");

  const ownershipDriftRoot = await install("ownership-drift", "claude");
  const ownershipPath = projectPaths(ownershipDriftRoot).clientOwnership;
  const ownershipValue = JSON.parse(fs.readFileSync(ownershipPath, "utf-8"));
  ownershipValue.clients.claude["hy-workflow"].desired.command = "changed-command";
  fs.writeFileSync(ownershipPath, JSON.stringify(ownershipValue, null, 2) + "\n");
  const ownershipDrift = await runSetupDoctor(ownershipDriftRoot, { offline: true });
  assert(!ownershipDrift.ok && ownershipDrift.checks.some(item => item.id === "coherence.ownership" && item.status === "fail"), "ownership desired-definition drift must fail doctor");

  const toolDriftRoot = await install("tool-drift");
  const deploymentPath = projectPaths(toolDriftRoot).deployment;
  const deploymentValue = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
  deploymentValue.tools["hy-workflow"].version = "different-version";
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentValue, null, 2) + "\n");
  const toolDrift = await runSetupDoctor(toolDriftRoot, { offline: true });
  assert(!toolDrift.ok && toolDrift.checks.some(item => item.id === "tool.hy-workflow" && item.status === "fail"), "recorded/live tool-evidence drift must fail doctor");

  const registryOnlyRoot = await install("registry-only");
  fs.rmSync(projectPaths(registryOnlyRoot).deployment);
  const registryOnly = await runSetupDoctor(registryOnlyRoot, { offline: true });
  assert(!registryOnly.ok && registryOnly.checks.some(item => item.id === "coherence.deployment" && item.status === "fail"), "registry-only external state must fail doctor");

  const globalOrphanRoot = await install("global-orphans");
  const globalPaths = projectPaths(globalOrphanRoot);
  const globalRegistry = JSON.parse(fs.readFileSync(globalPaths.registry, "utf-8"));
  const registryOrphanId = "a".repeat(24);
  const deploymentOrphanId = "b".repeat(24);
  globalRegistry.projects[registryOrphanId] = { ...globalRegistry.projects[globalPaths.identity.id], id: registryOrphanId, root: "/missing-registry-project" };
  fs.writeFileSync(globalPaths.registry, JSON.stringify(globalRegistry, null, 2) + "\n");
  const deploymentOrphan = JSON.parse(fs.readFileSync(globalPaths.deployment, "utf-8"));
  deploymentOrphan.identity = { ...deploymentOrphan.identity, id: deploymentOrphanId, root: "/missing-deployment-project" };
  const orphanStorage = projectStoragePaths(deploymentOrphanId);
  fs.mkdirSync(orphanStorage.stateDir, { recursive: true });
  fs.writeFileSync(orphanStorage.deployment, JSON.stringify(deploymentOrphan, null, 2) + "\n");
  const globalOrphans = await runSetupDoctor(globalOrphanRoot, { offline: true });
  const globalGraph = globalOrphans.checks.find(item => item.id === "coherence.global");
  const globalIssues = (globalGraph?.detail as any)?.issues ?? [];
  assert(globalGraph?.status === "fail" && globalIssues.some((item: string) => item.includes(registryOrphanId)) && globalIssues.some((item: string) => item.includes(deploymentOrphanId)), "doctor must name registry-only and deployment-only orphans for other projects");

  const unavailableRoot = await install("declared-unavailable", "claude");
  const unavailable = await runSetupDoctor(unavailableRoot, { offline: true });
  assert(!unavailable.ok && unavailable.checks.some(item => item.id === "client.claude" && item.status === "fail"), "a declared but unavailable client must fail doctor");

  const timeoutRoot = await install("codex-timeout", "codex");
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "hy-doctor-codex-home-"));
  process.env.CODEX_HOME = codexHome;
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    "[mcp_servers.hy-workflow]", 'command = "hy-workflow"', "args = []", "startup_timeout_sec = 1", "tool_timeout_sec = 2", "",
    "[mcp_servers.docs-gardener]", 'command = "docs-gardener"', 'args = ["mcp"]', "startup_timeout_sec = 1", "tool_timeout_sec = 2", "",
  ].join("\n"));
  const timeoutDrift = await runSetupDoctor(timeoutRoot, { offline: true });
  assert(!timeoutDrift.ok && timeoutDrift.checks.some(item => item.id === "client.codex.hy-workflow.timeouts" && item.status === "fail"), "Codex timeout drift must fail doctor");
  restoreHooks();
}

console.log("setup-doctor: state graph, tool evidence, timeout, and artifact diagnostics pass");
