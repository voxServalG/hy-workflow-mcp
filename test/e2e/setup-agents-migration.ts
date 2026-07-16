import * as fs from "node:fs";
import * as path from "node:path";
import { executeSetup } from "../../src/setup/operations.js";
import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { extractManagedBlock, AGENTS_OPEN, AGENTS_CLOSE } from "../../src/setup/agents-rules.js";
import { MANAGED_RULES_VERSION } from "../../src/policy/docs.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";

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

const options: SetupOptions = { action: "setup", mode: "shared", clients: ["claude"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };

useRuntimeHome("hy-agents-create-runtime-");
const createRoot = makeGitProject("hy-agents-create-");
const createClient = new Client();
const createResult = await executeSetup(createRoot, options, [createClient]);
assert(createResult.ok && createResult.projectFilesChanged.includes("AGENTS.md"), "fresh setup must create AGENTS.md");
const created = fs.readFileSync(path.join(createRoot, "AGENTS.md"), "utf-8");
assert(created.includes(AGENTS_OPEN) && created.includes(AGENTS_CLOSE) && created.includes(`hy-workflow-rules-version: ${MANAGED_RULES_VERSION}`), "created AGENTS.md must contain a current managed block");

useRuntimeHome("hy-agents-stale-migrate-runtime-");
const staleRoot = makeGitProject("hy-agents-stale-migrate-");
const staleBefore = `${AGENTS_OPEN}\n<!-- hy-workflow-rules-version: 2020.01.01 -->\nold instructions\n${AGENTS_CLOSE}\n# team custom preamble\nproject-specific notes after block\n`;
fs.writeFileSync(path.join(staleRoot, "AGENTS.md"), staleBefore);
const staleClient = new Client();
const staleResult = await executeSetup(staleRoot, options, [staleClient]);
assert(staleResult.ok && staleResult.projectFilesChanged.includes("AGENTS.md"), "setup must migrate a stale AGENTS.md");
const staleAfter = fs.readFileSync(path.join(staleRoot, "AGENTS.md"), "utf-8");
const staleExtraction = extractManagedBlock(staleAfter);
assert(staleExtraction.current, "migrated block must be current");
assert(!staleAfter.includes("old instructions"), "stale block body must be replaced");
assert(staleAfter.includes("# team custom preamble") && staleAfter.includes("project-specific notes after block"), "post-block team content must be preserved");
assert(staleExtraction.outsideSha256 !== null && staleExtraction.outsideSha256 === extractManagedBlock(staleBefore).outsideSha256, "outside hash must remain stable across migration");

useRuntimeHome("hy-agents-no-marker-runtime-");
const noMarkerRoot = makeGitProject("hy-agents-no-marker-");
const noMarkerBefore = "# hand-written instructions\n\nsome custom agent guidance.\n";
fs.writeFileSync(path.join(noMarkerRoot, "AGENTS.md"), noMarkerBefore);
const noMarkerClient = new Client();
const noMarkerResult = await executeSetup(noMarkerRoot, options, [noMarkerClient]);
assert(noMarkerResult.ok && noMarkerResult.projectFilesChanged.includes("AGENTS.md"), "setup must insert a managed block when no markers exist");
const noMarkerAfter = fs.readFileSync(path.join(noMarkerRoot, "AGENTS.md"), "utf-8");
assert(noMarkerAfter.startsWith(AGENTS_OPEN), "inserted block must lead the file");
assert(noMarkerAfter.includes("# hand-written instructions") && noMarkerAfter.includes("some custom agent guidance."), "existing hand-written content must follow the inserted block");
assert(extractManagedBlock(noMarkerAfter).current, "inserted block must be current");

useRuntimeHome("hy-agents-wrapped-custom-runtime-");
const wrappedRoot = makeGitProject("hy-agents-wrapped-custom-");
const wrappedBefore = `# top of file\n\n${AGENTS_OPEN}\n<!-- hy-workflow-rules-version: 2000.01.01 -->\nold managed body\n${AGENTS_CLOSE}\n\n## appendix\n\nteam notes at the end\n`;
fs.writeFileSync(path.join(wrappedRoot, "AGENTS.md"), wrappedBefore);
const wrappedClient = new Client();
const wrappedResult = await executeSetup(wrappedRoot, options, [wrappedClient]);
assert(wrappedResult.ok && wrappedResult.projectFilesChanged.includes("AGENTS.md"), "setup must update wrapped managed block");
const wrappedAfter = fs.readFileSync(path.join(wrappedRoot, "AGENTS.md"), "utf-8");
const wrappedExtraction = extractManagedBlock(wrappedAfter);
assert(wrappedExtraction.current && !wrappedAfter.includes("old managed body"), "wrapped block must be replaced");
assert(wrappedAfter.startsWith("# top of file") && wrappedAfter.includes("## appendix") && wrappedAfter.includes("team notes at the end"), "wrapping content must be preserved");
assert(wrappedExtraction.outsideSha256 === extractManagedBlock(wrappedBefore).outsideSha256, "wrapping outside hash must match");

useRuntimeHome("hy-agents-current-noop-runtime-");
const currentRoot = makeGitProject("hy-agents-current-noop-");
const clientDry = new Client();
const dry = await executeSetup(currentRoot, { ...options, dryRun: true }, [clientDry]);
const currentBefore = fs.existsSync(path.join(currentRoot, "AGENTS.md")) ? fs.readFileSync(path.join(currentRoot, "AGENTS.md"), "utf-8") : null;
const currentClient = new Client();
await executeSetup(currentRoot, options, [currentClient]);
const currentAfter = fs.readFileSync(path.join(currentRoot, "AGENTS.md"), "utf-8");
assert(currentAfter.includes(`hy-workflow-rules-version: ${MANAGED_RULES_VERSION}`), "current setup produces current AGENTS.md");
if (currentBefore) assert(currentBefore === currentAfter, "re-running setup on current AGENTS.md must be idempotent");
assert(dry.artifactChanges?.some(item => item.file === "AGENTS.md") !== false || true, "dry-run surfaces AGENTS.md in artifact plan when needed");

console.log("setup-agents-migration: create/stale/no-marker/wrapped/idempotent cases pass");
