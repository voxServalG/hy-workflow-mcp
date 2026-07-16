import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { projectPaths, userRoots } from "../../src/runtime/user-paths.js";
import { assertClientSnapshotUnchanged } from "../../src/setup/clients/effective.js";
import { definitionEquals } from "../../src/setup/clients/index.js";
import { executeSetup } from "../../src/setup/operations.js";
import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function treeFingerprint(): string {
  const entries: string[] = [];
  const visit = (target: string, label: string): void => {
    if (!fs.existsSync(target)) { entries.push(`${label}:absent`); return; }
    const stat = fs.lstatSync(target);
    entries.push(`${label}:${stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? `link:${fs.readlinkSync(target)}` : `file:${createHash("sha256").update(fs.readFileSync(target)).digest("hex")}`}:${stat.mode & 0o777}`);
    if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name), `${label}/${name}`);
  };
  const roots = userRoots();
  visit(roots.config, "config");
  visit(roots.state, "state");
  visit(roots.cache, "cache");
  return entries.join("\n");
}

class Client implements ClientAdapter {
  name = "codex" as const;
  values = new Map<ServerName, McpDefinition>();
  fingerprints = new Map<ServerName, string>();
  detect() { return { name: this.name, installed: true, executable: "codex", version: "test", configured: [...this.values.keys()] }; }
  inspect(server: ServerName): ClientServerSnapshot { return { definition: this.values.get(server) ?? null, ...(this.fingerprints.has(server) ? { raw: { entryFingerprint: this.fingerprints.get(server) } } : {}) }; }
  install(server: ServerName, definition: McpDefinition, expectedPrevious?: ClientServerSnapshot): ClientServerSnapshot {
    const previous = this.inspect(server);
    if (expectedPrevious) assertClientSnapshotUnchanged(this.name, server, expectedPrevious, previous);
    this.values.set(server, definition);
    this.fingerprints.set(server, `applied-${server}`);
    return previous;
  }
  remove(server: ServerName, expected: McpDefinition, previous?: ClientServerSnapshot | null, expectedCurrent?: ClientServerSnapshot) {
    const current = this.inspect(server);
    if (expectedCurrent) assertClientSnapshotUnchanged(this.name, server, expectedCurrent, current);
    if (!definitionEquals(current.definition, expected)) throw new Error(`unexpected current definition for ${server}`);
    if (previous?.definition) this.values.set(server, previous.definition);
    else { this.values.delete(server); this.fingerprints.delete(server); }
  }
}

const setupOptions: SetupOptions = { action: "setup", mode: "shared", clients: ["codex"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };

useRuntimeHome("hy-noop-unset-runtime-");
const noopRoot = makeGitProject("hy-noop-unset-");
const beforeNoop = treeFingerprint();
const firstNoop = await executeSetup(noopRoot, { ...setupOptions, action: "unset", clients: [] }, [], { inspectDirectTools: false });
const afterFirstNoop = treeFingerprint();
const secondNoop = await executeSetup(noopRoot, { ...setupOptions, action: "unset", clients: [] }, [], { inspectDirectTools: false });
assert(!firstNoop.removed && !secondNoop.removed && firstNoop.localFilesChanged.length === 0 && secondNoop.localFilesChanged.length === 0, "fresh-HOME unset must report a byte-preserving no-op");
assert(beforeNoop === afterFirstNoop && afterFirstNoop === treeFingerprint(), "repeated no-op unset must not create roots, registry revisions, locks, journals, or ownership files");

useRuntimeHome("hy-ownership-drift-runtime-");
const firstRoot = makeGitProject("hy-ownership-first-");
const secondRoot = makeGitProject("hy-ownership-second-");
const client = new Client();
await executeSetup(firstRoot, setupOptions, [client], { inspectDirectTools: false });
await executeSetup(firstRoot, { ...setupOptions, action: "unset", removeGlobal: false }, [client], { inspectDirectTools: false });
const external = { command: "external-command", args: ["--preserve"] };
client.values.set("hy-workflow", external);
let driftCode = "";
try { await executeSetup(secondRoot, setupOptions, [client], { inspectDirectTools: false }); }
catch (error: any) { driftCode = error?.code; }
assert(driftCode === "SETUP_OWNERSHIP_CONFLICT", "kept global ownership must fail closed when a later project sees external client drift");
assert(definitionEquals(client.values.get("hy-workflow") ?? null, external), "ownership conflict must preserve the external client edit");
assert(!fs.existsSync(path.join(secondRoot, "hy-workflow.json")) && !fs.existsSync(projectPaths(secondRoot).setupJournal), "ownership conflict must not write the second project or strand a transaction journal");

useRuntimeHome("hy-global-unset-corruption-runtime-");
const corruptRoot = makeGitProject("hy-global-unset-corruption-");
const corruptClient = new Client();
await executeSetup(corruptRoot, setupOptions, [corruptClient], { inspectDirectTools: false });
const corruptPaths = projectPaths(corruptRoot);
fs.rmSync(corruptPaths.clientOwnership);
let corruptCode = "";
try { await executeSetup(corruptRoot, { ...setupOptions, action: "unset", removeGlobal: true }, [corruptClient], { inspectDirectTools: false }); }
catch (error: any) { corruptCode = error?.code; }
assert(corruptCode === "SETUP_OWNERSHIP_CONFLICT", "global unset must fail before mutation when declared ownership evidence is missing");
assert(fs.existsSync(corruptPaths.deployment) && fs.existsSync(corruptPaths.registry) && corruptClient.values.size === 2, "ownership corruption must preserve local and global cleanup evidence");

useRuntimeHome("hy-global-orphan-runtime-");
const registeredRoot = makeGitProject("hy-global-registered-");
const orphanRoot = makeGitProject("hy-global-orphan-");
const sharedClient = new Client();
await executeSetup(registeredRoot, setupOptions, [sharedClient], { inspectDirectTools: false });
await executeSetup(orphanRoot, setupOptions, [sharedClient], { inspectDirectTools: false });
const registeredPaths = projectPaths(registeredRoot);
const orphanPaths = projectPaths(orphanRoot);
const orphanRegistry = JSON.parse(fs.readFileSync(registeredPaths.registry, "utf-8"));
delete orphanRegistry.projects[orphanPaths.identity.id];
fs.writeFileSync(registeredPaths.registry, JSON.stringify(orphanRegistry, null, 2) + "\n");
let orphanCode = "";
try { await executeSetup(registeredRoot, { ...setupOptions, action: "unset", removeGlobal: true }, [sharedClient], { inspectDirectTools: false }); }
catch (error: any) { orphanCode = error?.code; }
assert(orphanCode === "SETUP_STATE_GRAPH_INCOHERENT", "an orphan deployment must prevent false last-project global cleanup");
assert(fs.existsSync(registeredPaths.deployment) && fs.existsSync(orphanPaths.deployment) && sharedClient.values.size === 2, "orphan detection must preserve both deployments and shared client definitions");

useRuntimeHome("hy-applied-fingerprint-runtime-");
const fingerprintRoot = makeGitProject("hy-applied-fingerprint-");
const fingerprintClient = new Client();
await executeSetup(fingerprintRoot, setupOptions, [fingerprintClient], { inspectDirectTools: false });
const fingerprintPaths = projectPaths(fingerprintRoot);
fingerprintClient.fingerprints.set("hy-workflow", "same-definition-user-edit");
let fingerprintCode = "";
try { await executeSetup(fingerprintRoot, { ...setupOptions, action: "unset", removeGlobal: true }, [fingerprintClient], { inspectDirectTools: false }); }
catch (error: any) { fingerprintCode = error?.code; }
assert(fingerprintCode === "SETUP_OWNERSHIP_CONFLICT", "unset must reject a same-definition client target edit whose applied fingerprint changed");
assert(fs.existsSync(fingerprintPaths.deployment) && fingerprintClient.fingerprints.get("hy-workflow") === "same-definition-user-edit", "applied fingerprint conflict must preserve local evidence and the user edit");

console.log("setup-lifecycle-invariants: no-op, state graph, and applied ownership fingerprint guards pass");
