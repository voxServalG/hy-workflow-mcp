import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { defaultSuggestion, ensureConfigDefaults, withConfirmedCiCommands, withRuntimeCompatCoordination, type JsonObject } from "../config.js";
import { readDeployment, readDeploymentById, readRegistry, unregisterProject, writeDeployment, type ClientName, type DeploymentManifest, type UnregisterOutcome } from "../runtime/deployment.js";
import { atomicWriteJson, projectPaths, projectStoragePaths, userRoots } from "../runtime/user-paths.js";
import { assertSafeRuntimeBoundary } from "../runtime/boundary.js";
import { SETUP_VERSION } from "../bootstrap.js";
import { createClaudeAdapter } from "./clients/claude.js";
import { createCodexAdapter } from "./clients/codex.js";
import { assertDesiredEffectiveConfig, clientSnapshotEquals } from "./clients/effective.js";
import { definitionEquals } from "./clients/index.js";
import { createOpenCodeAdapter } from "./clients/opencode.js";
import { inspectSetupTools, runSetupPreflight, type SetupPreflight } from "./preflight.js";
import { SHARED_PROJECT_FILES, sharedArtifactEvidence, writeSharedArtifacts } from "./shared.js";
import { migrateLegacyClientConfigs, scanLegacyClientConfigs } from "./legacy-migration.js";
import { cacheReviewedArtifacts, clearReviewedArtifacts, loadReviewedArtifacts } from "./reviewed-artifacts.js";
import { setupFailpoint, withSetupTransaction, type ClientResourceEvidence, type SetupTransaction } from "./transaction.js";
import { internalSetupTestHooks } from "./test-hooks.js";
import {
  MCP_DEFINITIONS,
  SetupFailure,
  type ClientAdapter,
  type ClientDetection,
  type ClientServerSnapshot,
  type McpDefinition,
  type ServerName,
  type SetupOptions,
  type SetupResult,
} from "./types.js";

type OwnershipEntry = {
  desired: McpDefinition;
  previous: ClientServerSnapshot | null;
  applied?: ClientServerSnapshot;
};

type OwnershipManifest = {
  schemaVersion: "1";
  revision: number;
  clients: Partial<Record<ClientName, Partial<Record<ServerName, OwnershipEntry>>>>;
};

type ClientMutation = {
  adapter: ClientAdapter;
  server: ServerName;
  previous: ClientServerSnapshot;
  rollbackExpected: ClientServerSnapshot;
  resource: string;
};

type ClientOutcome = {
  clients: SetupResult["clients"];
  ownership: OwnershipManifest;
  mutations: ClientMutation[];
};

export function createClientAdapters(root = process.cwd()): ClientAdapter[] {
  return [createCodexAdapter(root), createClaudeAdapter(root), createOpenCodeAdapter(root)];
}

export function detectClients(adapters = createClientAdapters()): ClientDetection[] {
  return adapters.map(adapter => {
    try { return adapter.detect(); }
    catch (error: any) {
      return { name: adapter.name, installed: false, executable: null, version: null, configured: [], error: error?.message ?? String(error) };
    }
  });
}

function emptyOwnership(): OwnershipManifest {
  return { schemaVersion: "1", revision: 0, clients: {} };
}

export function readOwnership(root: string): OwnershipManifest {
  const file = projectPaths(root).clientOwnership;
  if (!fs.existsSync(file)) return emptyOwnership();
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (value?.schemaVersion !== "1" || !value.clients || typeof value.clients !== "object") throw new Error("unsupported shape");
    return { ...value, revision: Number.isInteger(value.revision) ? value.revision : 0 };
  } catch (error: any) {
    throw new SetupFailure(
      "ownership",
      "SETUP_OWNERSHIP_CONFLICT",
      `Client ownership manifest is unreadable: ${file}`,
      "Repair this file or use doctor reconciliation. Setup will not assume that global MCP entries are unowned.",
      { file, cause: error?.message ?? String(error) },
    );
  }
}

function jsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, null, 2) + "\n").digest("hex");
}

function writeOwnership(root: string, ownership: OwnershipManifest, transaction?: SetupTransaction): void {
  ownership.revision += 1;
  const file = projectPaths(root).clientOwnership;
  transaction?.prepareExpected(file, jsonHash(ownership));
  setupFailpoint("ownership");
  atomicWriteJson(file, ownership);
}

function selectedAdapters(options: SetupOptions, adapters: ClientAdapter[]): ClientAdapter[] {
  const selected = new Set(options.clients);
  const result = adapters.filter(adapter => selected.has(adapter.name));
  const missing = options.clients.filter(name => !result.some(adapter => adapter.name === name));
  if (missing.length) throw new SetupFailure("client_missing", "SETUP_CLIENT_NOT_INSTALLED", `Unsupported clients: ${missing.join(", ")}`);
  return result;
}

function snapshotFor(preflight: SetupPreflight, adapter: ClientAdapter, server: ServerName): ClientServerSnapshot {
  return preflight.snapshots[adapter.name]?.[server] ?? adapter.inspect(server);
}

function clientJournalSnapshot(snapshot: ClientServerSnapshot): unknown {
  let raw: unknown;
  try { raw = snapshot.raw === undefined ? undefined : JSON.parse(JSON.stringify(snapshot.raw)); }
  catch { raw = undefined; }
  return {
    definition: snapshot.definition,
    raw,
    source: snapshot.source,
    scope: snapshot.scope,
    enabled: snapshot.enabled,
    state: snapshot.state,
    ownedDefinition: snapshot.ownedDefinition,
    sources: snapshot.sources,
  };
}

function desiredClientJournalSnapshot(client: ClientName, definition: McpDefinition): ClientServerSnapshot {
  return {
    definition,
    enabled: true,
    state: "active",
    ...(client === "codex" ? { raw: { startup_timeout_sec: 60, tool_timeout_sec: 300 } } : {}),
  };
}

function evidenceSnapshot(value: unknown): ClientServerSnapshot {
  if (!value || typeof value !== "object") return { definition: null, state: "absent" };
  if ("definition" in value) return value as ClientServerSnapshot;
  if ("command" in value && "args" in value) return { definition: value as McpDefinition };
  return { definition: null, state: "unreadable" };
}

function snapshotMatches(current: ClientServerSnapshot, expected: ClientServerSnapshot): boolean {
  if (current.state === "shadowed" || current.state === "unreadable" || current.scope === "project") return false;
  if (expected.definition ? !current.definition || !definitionEquals(current.definition, expected.definition) : Boolean(current.definition)) return false;
  if (expected.enabled !== undefined && expected.enabled !== null && current.enabled !== undefined && current.enabled !== expected.enabled) return false;
  const expectedRaw = expected.raw as any;
  const currentRaw = current.raw as any;
  for (const key of ["startup_timeout_sec", "tool_timeout_sec", "configMode"]) {
    if (expectedRaw?.[key] !== undefined && Number(currentRaw?.[key]) !== Number(expectedRaw[key])) return false;
  }
  for (const key of ["sectionFingerprint", "entryFingerprint"]) {
    if (expectedRaw?.[key] !== undefined && String(currentRaw?.[key]) !== String(expectedRaw[key])) return false;
  }
  return true;
}

function clientCommand<T>(client: ClientName, server: ServerName, operation: "install" | "remove", run: () => T): T {
  try { return run(); }
  catch (error) {
    if (error instanceof SetupFailure) throw error;
    throw new SetupFailure(
      "client_config",
      "SETUP_CLIENT_COMMAND_FAILED",
      `${client} ${operation} command failed for ${server}.`,
      "Inspect the client configuration and command output, then retry setup. The ownership journal was preserved.",
      { client, server, operation, cause: error instanceof Error ? error.message : String(error) },
      true,
    );
  }
}

function reconcileClientResource(adapters: ClientAdapter[], evidence: ClientResourceEvidence): boolean {
  const match = /^client:(codex|claude|opencode):(hy-workflow|docs-gardener)$/.exec(evidence.resource);
  if (!match || !evidence.action) return false;
  const client = match[1] as ClientName;
  const server = match[2] as ServerName;
  const adapter = adapters.find(item => item.name === client);
  if (!adapter?.detect().installed) return false;
  const previous = evidenceSnapshot(evidence.previous);
  const desired = evidenceSnapshot(evidence.desired);
  let current = adapter.inspect(server);
  if (snapshotMatches(current, previous)) return true;
  // A process can die after the client command mutates configuration but
  // before the adapter returns its exact applied fingerprint. Bare/provisional
  // desired evidence cannot distinguish setup output from a same-definition
  // user edit, so it is never eligible for automatic rollback.
  if (evidence.appliedExact !== true) return false;
  if (!snapshotMatches(current, desired)) return false;
  if (evidence.action === "install") {
    if (!desired.definition) return false;
    adapter.remove(server, desired.definition, previous, current);
  } else {
    if (!previous.definition) return false;
    adapter.install(server, previous.definition, current);
  }
  current = adapter.inspect(server);
  return snapshotMatches(current, previous);
}

function codexTimeoutsCurrent(snapshot: ClientServerSnapshot): boolean {
  const raw = snapshot.raw as any;
  const realCodexSnapshot = Boolean(snapshot.source?.endsWith("config.toml") || raw?.transport || raw?.startup_timeout_sec !== undefined || raw?.tool_timeout_sec !== undefined);
  if (!realCodexSnapshot) return true;
  return Number(raw?.startup_timeout_sec) === 60 && Number(raw?.tool_timeout_sec) === 300;
}

function plannedStatus(adapter: ClientAdapter, previous: ClientServerSnapshot, desired: McpDefinition): SetupResult["clients"][number]["status"] {
  if (!previous.definition) return "configured";
  if (!definitionEquals(previous.definition, desired)) return "replaced";
  if (adapter.name === "codex" && !codexTimeoutsCurrent(previous)) return "replaced";
  return "unchanged";
}

function previewClients(selected: ClientAdapter[], preflight: SetupPreflight): SetupResult["clients"] {
  return selected.flatMap(adapter => (Object.keys(MCP_DEFINITIONS) as ServerName[]).map(server => {
    const previous = snapshotFor(preflight, adapter, server);
    return {
      name: adapter.name,
      status: plannedStatus(adapter, previous, MCP_DEFINITIONS[server]),
      detail: server,
      source: previous.source,
      scope: previous.scope,
    };
  }));
}

function installClients(
  root: string,
  selected: ClientAdapter[],
  preflight: SetupPreflight,
  options: SetupOptions,
  transaction?: SetupTransaction,
): ClientOutcome {
  const ownership = readOwnership(root);
  const mutations: ClientMutation[] = [];
  const clients: SetupResult["clients"] = [];
  try {
    for (const adapter of selected) {
      for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
        const desired = MCP_DEFINITIONS[server];
        const previous = snapshotFor(preflight, adapter, server);
        const existing = ownership.clients[adapter.name]?.[server];
        // Ownership drift is determined purely by MCP semantics (command/args/env)
        // and scope/source/enabled. Setup-maintained sidecar fields in the raw
        // config (codex startup_timeout_sec/tool_timeout_sec/sectionFingerprint,
        // file mode bits) are re-applied by install() on every setup run and
        // must never block upgrade just because they diverge from what setup
        // last wrote. Real external edits (different command, moved scope,
        // disabled server, different args/env) still hard-fail here.
        const coreSnapshotEquals = (a: ClientServerSnapshot, b: ClientServerSnapshot): boolean => {
          if (a.definition ? !b.definition || !definitionEquals(a.definition, b.definition) : Boolean(b.definition)) return false;
          if (a.ownedDefinition ? !b.ownedDefinition || !definitionEquals(a.ownedDefinition, b.ownedDefinition) : Boolean(b.ownedDefinition)) return false;
          if ((a.source ?? null) !== (b.source ?? null)) return false;
          if ((a.scope ?? null) !== (b.scope ?? null)) return false;
          if ((a.enabled ?? null) !== (b.enabled ?? null)) return false;
          return true;
        };
        const ownershipDrift = existing ? (existing.applied ? !coreSnapshotEquals(previous, existing.applied) : !definitionEquals(previous.definition, existing.desired)) : false;
        if (existing && ownershipDrift) {
          const forceRequested = options.forceClientOverwrite?.includes(adapter.name) ?? false;
          if (!forceRequested) {
            const conflictSource = previous.sources?.find(s => s.scope === "project")?.source
              ?? previous.sources?.find(s => s.scope === "user")?.source
              ?? previous.source
              ?? "(unknown)";
            throw new SetupFailure(
              "ownership",
              "SETUP_OWNERSHIP_CONFLICT",
              `${adapter.name} ${server} no longer matches the definition owned by hy-workflow.`,
              [
                `Existing entry source: ${conflictSource}`,
                `To overwrite the user-scope definition owned by hy-workflow, rerun with --force-client-overwrite ${adapter.name}`,
                "Project-scope (tracked legacy) files are never modified by setup; use --migrate-legacy-clients to back them up first.",
              ].join("\n"),
              { client: adapter.name, server, ownedDesired: existing.desired, applied: existing.applied, current: previous, conflictSource },
            );
          }
          // Force path: remove current user-scope entry, then reinstall desired. Project-scope
          // files are untouched here; if they exist, --migrate-legacy-clients should be used.
          adapter.remove(server, existing.desired, existing.previous, previous);
          ownership.clients[adapter.name]![server] = undefined as any;
        }
        const status = plannedStatus(adapter, previous, desired);
        const needsInstall = status !== "unchanged";
        if (existing && !existing.applied && needsInstall) {
          const forceRequested = options.forceClientOverwrite?.includes(adapter.name) ?? false;
          if (!forceRequested) {
            throw new SetupFailure(
              "ownership",
              "SETUP_OWNERSHIP_CONFLICT",
              `${adapter.name} ${server} has legacy ownership evidence but requires a client rewrite.`,
              `Reconcile the client entry explicitly, or rerun with --force-client-overwrite ${adapter.name} to overwrite the user-scope entry.`,
              { client: adapter.name, server, current: previous, status },
            );
          }
          adapter.remove(server, existing.desired, existing.previous, previous);
          ownership.clients[adapter.name]![server] = undefined as any;
        }
        if (needsInstall) {
          const resource = `client:${adapter.name}:${server}`;
          setupFailpoint(resource);
          const desiredSnapshot = desiredClientJournalSnapshot(adapter.name, desired);
          transaction?.markClient(resource, { action: "install", previous: clientJournalSnapshot(previous), desired: desiredSnapshot, appliedExact: false });
          const mutation: ClientMutation = { adapter, server, previous, rollbackExpected: desiredSnapshot, resource };
          mutations.push(mutation);
          const runInstall = () => adapter.install(server, desired, previous);
          const runForceReinstall = () => {
            try { adapter.remove(server, desired, existing?.previous ?? null, previous); } catch { /* best effort */ }
            return adapter.install(server, desired);
          };
          const actualPrevious = clientCommand(adapter.name, server, "install", () => {
            try {
              return runInstall();
            } catch (installError: any) {
              const forceRequested = options.forceClientOverwrite?.includes(adapter.name) ?? false;
              if (forceRequested && (installError instanceof SetupFailure)
                && (installError.subtype === "client_config" || installError.subtype === "client_shadowed" || installError.code === "SETUP_CLIENT_CONFIG_UNSAFE" || installError.code === "SETUP_EFFECTIVE_CONFIG_SHADOWED")) {
                return runForceReinstall();
              }
              throw installError;
            }
          });
          mutation.previous = actualPrevious;
          internalSetupTestHooks().afterClientCommandBeforeJournal?.(adapter.name, server);
          // Durable recovery restores the locked preflight baseline. The
          // adapter-returned snapshot can contain sibling mutations made by
          // this transaction and belongs only to in-process reverse rollback.
          transaction?.markClient(resource, { action: "install", previous: clientJournalSnapshot(previous), desired: desiredSnapshot, appliedExact: false });
          if (!clientSnapshotEquals(actualPrevious, previous)) {
            throw new SetupFailure("client_config", "SETUP_CLIENT_CONFIG_UNSAFE", `${adapter.name} ${server} changed during installation; refusing stale ownership.`, "The adapter must restore the concurrent definition before retrying setup.", { expected: previous, actual: actualPrevious }, true);
          }
        }
        const effective = needsInstall ? adapter.inspect(server) : previous;
        if (needsInstall) {
          const mutation = mutations[mutations.length - 1];
          mutation.rollbackExpected = effective;
          transaction?.markClient(mutation.resource, {
            action: "install",
            previous: clientJournalSnapshot(previous),
            desired: clientJournalSnapshot(effective),
            appliedExact: true,
          });
        }
        assertDesiredEffectiveConfig(adapter.name, server, effective, desired);
        if (adapter.name === "codex" && !codexTimeoutsCurrent(effective)) {
          throw new SetupFailure("postcondition", "SETUP_POSTCONDITION_FAILED", `Codex ${server} timeouts are not startup=60/tool=300.`, "Run hy-workflow doctor --json.", { server, raw: effective.raw });
        }
        ownership.clients[adapter.name] ??= {};
        ownership.clients[adapter.name]![server] = {
          desired,
          // Ownership restores the locked preflight state. The adapter's
          // actualPrevious snapshot may include sibling mutations made earlier
          // in this transaction and is reserved for reverse-order rollback.
          previous: existing?.previous ?? previous,
          applied: clientJournalSnapshot(effective) as ClientServerSnapshot,
        };
        clients.push({ name: adapter.name, status, detail: server, source: effective.source, scope: effective.scope });
      }
    }
    return { clients, ownership, mutations };
  } catch (error) {
    rollbackInstalled(mutations, transaction);
    throw error;
  }
}

function rollbackInstalled(mutations: ClientMutation[], transaction?: SetupTransaction): void {
  for (const item of [...mutations].reverse()) {
    try {
      item.adapter.remove(item.server, MCP_DEFINITIONS[item.server], item.previous, item.rollbackExpected);
      transaction?.unmarkClient(item.resource);
    } catch {}
  }
}

function removeClients(root: string, selected: ClientAdapter[], transaction?: SetupTransaction): ClientOutcome {
  const ownership = readOwnership(root);
  const clients: SetupResult["clients"] = [];
  const mutations: ClientMutation[] = [];
  try {
    for (const adapter of selected) {
      const detection = adapter.detect();
      for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
        const entry = ownership.clients[adapter.name]?.[server];
        if (!entry) {
          clients.push({ name: adapter.name, status: "skipped", detail: `${server}: not owned` });
          continue;
        }
        if (!detection.installed) {
          clients.push({ name: adapter.name, status: "recovery_required", detail: `${server}: client unavailable; ownership kept` });
          continue;
        }
        if (!entry.applied) {
          throw new SetupFailure("ownership", "SETUP_OWNERSHIP_CONFLICT", `${adapter.name} ${server} has legacy ownership without an applied target fingerprint.`, "Run setup first to backfill unchanged ownership evidence, then retry unset.", { client: adapter.name, server });
        }
        const resource = `client:${adapter.name}:${server}`;
        setupFailpoint(resource);
        const before = adapter.inspect(server);
        if (!clientSnapshotEquals(before, entry.applied, { strictSidecars: true })) {
          throw new SetupFailure(
            "ownership",
            "SETUP_OWNERSHIP_CONFLICT",
            `${adapter.name} ${server} changed after setup; refusing to overwrite the user edit during unset.`,
            "Review the target client section/entry and reconcile it explicitly before retrying unset.",
            { client: adapter.name, server, applied: entry.applied, current: before },
          );
        }
        transaction?.markClient(resource, { action: "remove", previous: clientJournalSnapshot(before), desired: entry.previous ? clientJournalSnapshot(entry.previous) : { definition: null, state: "absent" }, appliedExact: false });
        const afterExpected = entry.previous ?? { definition: null, state: "absent" as const };
        mutations.push({ adapter, server, previous: before, rollbackExpected: afterExpected, resource });
        clientCommand(adapter.name, server, "remove", () => adapter.remove(server, entry.desired, entry.previous, before));
        const actualAfter = adapter.inspect(server);
        if (!snapshotMatches(actualAfter, afterExpected)) {
          throw new SetupFailure("postcondition", "SETUP_POSTCONDITION_FAILED", `${adapter.name} ${server} removal did not produce the owned restoration state.`, "The ownership record was kept; inspect the client and retry unset.", { client: adapter.name, server, expected: afterExpected, actual: actualAfter });
        }
        mutations[mutations.length - 1].rollbackExpected = actualAfter;
        transaction?.markClient(resource, { action: "remove", previous: clientJournalSnapshot(before), desired: clientJournalSnapshot(actualAfter), appliedExact: true });
        delete ownership.clients[adapter.name]![server];
        clients.push({ name: adapter.name, status: "removed", detail: server, source: before.source, scope: before.scope });
      }
      if (ownership.clients[adapter.name] && !Object.keys(ownership.clients[adapter.name]!).length) delete ownership.clients[adapter.name];
    }
    return { clients, ownership, mutations };
  } catch (error) {
    rollbackRemoved(mutations, transaction);
    throw error;
  }
}

function rollbackRemoved(mutations: ClientMutation[], transaction?: SetupTransaction): void {
  for (const item of [...mutations].reverse()) {
    try {
      item.adapter.install(item.server, MCP_DEFINITIONS[item.server], item.rollbackExpected);
      transaction?.unmarkClient(item.resource);
    } catch {}
  }
}

function ownedClients(ownership: OwnershipManifest): ClientName[] {
  return (Object.keys(ownership.clients) as ClientName[]).filter(name => Object.keys(ownership.clients[name] ?? {}).length > 0);
}

function sameClientSet(left: ClientName[], right: ClientName[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function registryMatchesDeployment(record: any, deployment: DeploymentManifest): boolean {
  const identity = deployment.identity;
  return Boolean(record
    && record.id === identity.id
    && record.root === identity.root
    && record.gitCommonDir === identity.gitCommonDir
    && record.remote === identity.remote
    && record.mode === deployment.mode
    && sameClientSet(record.clients ?? [], deployment.clients)
    && record.updatedAt === deployment.updatedAt);
}

function assertGlobalDeploymentGraph(root: string, registry: ReturnType<typeof readRegistry>): void {
  const projectsDir = path.join(userRoots().state, "projects");
  const deployments = new Map<string, DeploymentManifest>();
  const issues: string[] = [];
  if (fs.existsSync(projectsDir)) {
    for (const id of fs.readdirSync(projectsDir)) {
      if (!/^[a-f0-9]{24}$/.test(id)) continue;
      const directory = path.join(projectsDir, id);
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink()) { issues.push(`project state is a symlink: ${directory}`); continue; }
      if (!stat.isDirectory() || !fs.existsSync(path.join(directory, "deployment.json"))) continue;
      const deployment = readDeploymentById(id);
      if (!deployment || deployment.schemaVersion !== "3") { issues.push(`project ${id} has missing or legacy deployment evidence`); continue; }
      if (deployment.identity.id !== id) issues.push(`project ${id} deployment identity is ${deployment.identity.id}`);
      deployments.set(id, deployment);
    }
  }
  const ids = new Set([...Object.keys(registry.projects), ...deployments.keys()]);
  for (const id of ids) {
    const record = registry.projects[id];
    const deployment = deployments.get(id);
    if (!record || !deployment) issues.push(`registry/deployment pair is incomplete for ${id}`);
    else if (!registryMatchesDeployment(record, deployment)) issues.push(`registry/deployment pair drifted for ${id}`);
  }
  if (issues.length) {
    throw new SetupFailure(
      "registry",
      "SETUP_STATE_GRAPH_INCOHERENT",
      "Global deployment state is incomplete; refusing last-project client cleanup.",
      "Preserve registry and project state, run hy-workflow doctor --offline --json, and reconcile every orphan before retrying unset.",
      { issues },
    );
  }
}

function assertGlobalUnsetOwnership(root: string, deployment: ReturnType<typeof readDeploymentById>, ownership: OwnershipManifest, selected: ClientAdapter[]): void {
  const expected = new Set<ClientName>([
    ...(deployment?.schemaVersion === "3" ? deployment.clients : []),
    ...ownedClients(ownership),
  ]);
  if (expected.size && !fs.existsSync(projectPaths(root).clientOwnership)) {
    throw new SetupFailure("ownership", "SETUP_OWNERSHIP_CONFLICT", "Global client ownership evidence is missing.", "Restore the ownership manifest or reconcile client definitions manually before global unset.");
  }
  const missing: string[] = [];
  for (const client of expected) {
    for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
      const entry = ownership.clients[client]?.[server];
      if (!entry || !entry.applied || !definitionEquals(entry.desired, MCP_DEFINITIONS[server])) missing.push(`${client}/${server}`);
    }
  }
  const selectedNames = new Set(selected.map(adapter => adapter.name));
  const unselected = [...expected].filter(client => !selectedNames.has(client));
  if (missing.length || unselected.length) {
    throw new SetupFailure(
      "ownership",
      "SETUP_OWNERSHIP_CONFLICT",
      "Global unset lacks complete, selected ownership evidence.",
      "Select every owned client and preserve the ownership file; setup will not delete local deployment evidence while global cleanup is ambiguous.",
      { missing, unselected },
    );
  }
}

async function postcondition(
  root: string,
  selected: ClientAdapter[],
  preflight: SetupPreflight,
  expectedClients: ClientName[],
  expectedArtifactHashes: Record<string, string>,
  assertReadiness: () => void,
  inspectDirectTools: boolean,
): Promise<void> {
  setupFailpoint("postcondition");
  const fail = (message: string, detail?: unknown): never => {
    throw new SetupFailure("postcondition", "SETUP_POSTCONDITION_FAILED", message, "Run hy-workflow doctor --offline --json before retrying setup.", detail);
  };
  for (const adapter of selected) {
    for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
      const current = adapter.inspect(server);
      assertDesiredEffectiveConfig(adapter.name, server, current, MCP_DEFINITIONS[server]);
      if (adapter.name === "codex" && !codexTimeoutsCurrent(current)) fail(`Codex ${server} timeout postcondition failed.`, { server, raw: current.raw });
    }
  }
  const paths = projectPaths(root);
  const deployment = readDeployment(root);
  if (!deployment || deployment.schemaVersion !== "3") fail("Deployment manifest was not committed with schema 3.");
  const committed = deployment as DeploymentManifest;
  if (committed.setupVersion !== SETUP_VERSION) fail("Deployment setupVersion does not match this setup binary.", { expected: SETUP_VERSION, actual: committed.setupVersion });
  const identity = paths.identity;
  if (committed.identity.id !== identity.id || committed.identity.root !== identity.root || committed.identity.gitCommonDir !== identity.gitCommonDir || committed.identity.remote !== identity.remote) {
    fail("Deployment identity does not match the current project.", { expected: identity, actual: committed.identity });
  }
  const clients = [...new Set(expectedClients)].sort();
  if (committed.mode !== "shared" || committed.clients.join("\n") !== clients.join("\n")) fail("Deployment mode or client set is incomplete.", { expected: { mode: "shared", clients }, actual: { mode: committed.mode, clients: committed.clients } });
  if (committed.projectFiles.join("\n") !== [...SHARED_PROJECT_FILES].sort().join("\n")) fail("Deployment project file ownership is incomplete.", { projectFiles: committed.projectFiles });
  if (JSON.stringify(committed.tools) !== JSON.stringify(preflight.tools)) fail("Deployment tool evidence does not match this preflight.", { expected: preflight.tools, actual: committed.tools });
  const registry = readRegistry(root);
  const record = registry.projects[identity.id];
  if (!record || record.id !== identity.id || record.root !== identity.root || record.gitCommonDir !== identity.gitCommonDir || record.remote !== identity.remote || record.mode !== "shared" || record.clients.join("\n") !== clients.join("\n") || record.updatedAt !== committed.updatedAt) {
    fail("Deployment registry record does not match the committed deployment.", { expected: { ...identity, mode: "shared", clients, updatedAt: committed.updatedAt }, actual: record });
  }
  const ownership = readOwnership(root);
  for (const adapter of selected) {
    for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
      const entry = ownership.clients[adapter.name]?.[server];
      const current = adapter.inspect(server);
      if (!entry || !entry.applied || !definitionEquals(entry.desired, MCP_DEFINITIONS[server]) || !clientSnapshotEquals(current, entry.applied)) fail(`Ownership postcondition failed for ${adapter.name}/${server}.`, { entry, current });
    }
  }
  const evidence = sharedArtifactEvidence(root);
  for (const file of SHARED_PROJECT_FILES) {
    const actual = evidence[file];
    const recorded = committed.artifacts[file];
    const expected = expectedArtifactHashes[file];
    if (!actual || !recorded || !expected || actual.sha256 !== expected || recorded.sha256 !== expected || recorded.size !== actual.size) fail(`Shared artifact postcondition failed: ${file}`, { expected, actual, recorded });
  }
  assertReadiness();
  if (inspectDirectTools) {
    const liveTools = await inspectSetupTools(root);
    if (JSON.stringify(liveTools) !== JSON.stringify(preflight.tools)) fail("Direct MCP binary evidence changed after locked setup preflight.", { recorded: preflight.tools, live: liveTools });
  }
}

function setupResult(
  root: string,
  options: SetupOptions,
  preflight: SetupPreflight,
  clients: SetupResult["clients"],
  projectFilesChanged: string[],
  transactionId?: string,
): SetupResult {
  const paths = projectPaths(root);
  const copy = options.language === "en"
    ? {
        changed: `Shared project files changed: ${projectFilesChanged.join(", ")}`,
        current: "Shared project files already current",
      }
    : {
        changed: `已写入团队产物：${projectFilesChanged.join("、")}`,
        current: "团队产物已是最新 (already current)",
      };
  return {
    ok: true,
    action: "setup",
    mode: "shared",
    projectId: paths.identity.id,
    projectRoot: paths.identity.root,
    clients,
    projectFilesChanged,
    localFilesChanged: options.dryRun ? [] : [paths.deployment, paths.registry, paths.clientOwnership],
    dryRun: options.dryRun,
    message: projectFilesChanged.length ? copy.changed : copy.current,
    transactionId,
    tools: preflight.tools,
    artifactChanges: preflight.artifactChanges,
    ciCandidates: preflight.ciCandidates,
    ciConfirmationRequired: preflight.ciConfirmationRequired,
  };
}

function confirmedConfig(root: string, candidate: JsonObject, options: SetupOptions): { config: JsonObject; candidates: string[]; confirmationRequired: boolean } {
  const current = (candidate.ci as any)?.commands;
  if (Array.isArray(current) && current.length && current.every(item => typeof item === "string" && item.trim())) {
    return { config: candidate, candidates: [...current], confirmationRequired: false };
  }
  const candidates = defaultSuggestion(root).ciCommands;
  const explicit = options.ciCommands?.filter(command => command.trim()) ?? [];
  if (explicit.length) return { config: withConfirmedCiCommands(candidate, explicit), candidates, confirmationRequired: false };
  if (options.acceptCiCommands && candidates.length) {
    throw new SetupFailure(
      "preflight",
      "SETUP_PREFLIGHT_FAILED",
      "CI command acceptance is missing the exact reviewed command list.",
      "Review the detected commands again; the caller must pass those exact strings as ciCommands.",
      { candidates },
    );
  }
  if (options.dryRun) return { config: candidate, candidates, confirmationRequired: true };
  const hint = candidates.length
    ? `Review the detected commands and rerun with --accept-ci-commands, or pass one or more --ci-command values: ${candidates.join("; ")}`
    : "No safe native CI command was detected. Pass one or more explicit --ci-command values after verifying them.";
  throw new SetupFailure("preflight", "SETUP_PREFLIGHT_FAILED", "Native CI commands require explicit confirmation before setup can write the workflow.", hint, { candidates });
}

async function withUnsetCoordination<T>(root: string, run: () => Promise<T>): Promise<T> {
  try {
    return await withRuntimeCompatCoordination(root, run);
  } catch (error: any) {
    if (error?.code === "RUNTIME_COMPAT_LOCK_BUSY") {
      throw new SetupFailure("transaction", "SETUP_CONCURRENT_OPERATION", error.message, error.hint, error.detail, true);
    }
    if (typeof error?.code === "string" && error.code.startsWith("RUNTIME_COMPAT_")) {
      throw new SetupFailure("transaction", "SETUP_RECOVERY_REQUIRED", error.message, error.hint, error.detail);
    }
    throw error;
  }
}

async function executeInstall(
  root: string,
  options: SetupOptions,
  selected: ClientAdapter[],
  allAdapters: ClientAdapter[],
  inspectDirectTools: boolean,
): Promise<SetupResult> {
  const readCandidate = (): JsonObject => {
    const result = ensureConfigDefaults(root, { dryRun: true });
    if (!result.ok || !result.candidate) throw new SetupFailure("preflight", "SETUP_PREFLIGHT_FAILED", result.display.body, result.hint);
    return result.candidate;
  };
  const { projectReadinessIssues } = await import("../tools/init.js");
  const assertReadiness = (candidate: JsonObject): void => {
    const readiness = projectReadinessIssues(root, candidate, { forSetup: true });
    if (readiness.length) {
      throw new SetupFailure(
        "preflight",
        "SETUP_PREFLIGHT_FAILED",
        readiness.map(issue => `${issue.code}: ${issue.message}`).join("\n"),
        readiness.map(issue => issue.recovery).join("\n"),
        { issues: readiness },
      );
    }
  };
  const initialCandidate = readCandidate();
  assertReadiness(initialCandidate);

  // Migrate legacy project-level client MCP definitions before doing anything else
  // (back up to .hy-cleanup-backup and ensure user-scope definitions exist).
  let legacyMigrationReport: { backupDir: string; moved: string[]; installedUserScope: string[] } | null = null;
  if (options.migrateLegacyClients && !options.dryRun) {
    legacyMigrationReport = migrateLegacyClientConfigs(root, allAdapters);
  }

  const confirmed = confirmedConfig(root, initialCandidate, options);
  const config = confirmed.config;
  // A mutating setup repeats every safety check after acquiring the global
  // transaction lock. Keep the unlocked preview cheap so a burst of setup
  // processes cannot launch duplicate version probes and MCP handshakes.
  const preflight = await runSetupPreflight(root, options, selected, config, options.dryRun && inspectDirectTools);
  preflight.ciCandidates = confirmed.candidates;
  preflight.ciConfirmationRequired = confirmed.confirmationRequired;
  if (options.dryRun) {
    return setupResult(root, options, preflight, previewClients(selected, preflight), preflight.artifactChanges.map(item => item.file));
  }
  await internalSetupTestHooks().afterSetupPreflightBeforeLock?.(root);
  return withSetupTransaction(root, "setup", async transaction => {
    internalSetupTestHooks().beforeLockedPreflight?.(root);
    const lockedConfirmed = confirmedConfig(root, readCandidate(), options);
    const lockedConfig = lockedConfirmed.config;
    assertReadiness(lockedConfig);
    const lockedPreflight = await runSetupPreflight(root, options, selected, lockedConfig, inspectDirectTools);
    lockedPreflight.ciCandidates = lockedConfirmed.candidates;
    lockedPreflight.ciConfirmationRequired = lockedConfirmed.confirmationRequired;
    const paths = projectPaths(root);
    const projectFiles = SHARED_PROJECT_FILES.map(file => path.join(root, file));
    internalSetupTestHooks().afterLockedPreflight?.(root);
    transaction.capture([...projectFiles, paths.deployment, paths.registry, paths.clientOwnership]);
    for (const file of SHARED_PROJECT_FILES) transaction.assertCaptured(path.join(root, file), lockedPreflight.artifactBeforeHashes[file] ?? null);
    const expectedArtifactHashes = lockedPreflight.artifactExpectedHashes;
    const installed = installClients(root, selected, lockedPreflight, options, transaction);
    try {
      writeOwnership(root, installed.ownership, transaction);
      transaction.markApplied([paths.clientOwnership]);
      const projectFilesChanged = writeSharedArtifacts(
        root,
        lockedConfig,
        false,
        file => {
          transaction.prepareExpected(path.join(root, file), expectedArtifactHashes[file]);
          if (file === "hy-workflow.json") setupFailpoint("shared:config");
          else if (file === ".github/workflows/hy-workflow.yml") setupFailpoint("shared:workflow");
          else if (file === "AGENTS.md") setupFailpoint("shared:agents");
        },
        file => transaction.markApplied([path.join(root, file)]),
      );
      const artifacts = sharedArtifactEvidence(root);
      writeDeployment(
        root,
        { setupVersion: SETUP_VERSION, mode: "shared", clients: options.clients, projectFiles: [...SHARED_PROJECT_FILES], tools: lockedPreflight.tools, artifacts },
        (resource, value) => {
          transaction.prepareExpected(resource === "deployment" ? paths.deployment : paths.registry, jsonHash(value));
          setupFailpoint(resource);
        },
        resource => transaction.markApplied([resource === "deployment" ? paths.deployment : paths.registry]),
      );
      await postcondition(root, selected, lockedPreflight, options.clients, expectedArtifactHashes, () => {
        const finalConfirmed = confirmedConfig(root, readCandidate(), options);
        assertReadiness(finalConfirmed.config);
      }, inspectDirectTools);
      return setupResult(root, options, lockedPreflight, installed.clients, projectFilesChanged, transaction.id);
    } catch (error) {
      rollbackInstalled(installed.mutations, transaction);
      throw error;
    }
  }, { reconcileClient: resource => reconcileClientResource(allAdapters, resource) });
}

async function executeUnset(root: string, options: SetupOptions, selected: ClientAdapter[], allAdapters: ClientAdapter[]): Promise<SetupResult> {
  const paths = projectPaths(root);
  const preflight = await runSetupPreflight(root, options, selected, {}, false);
  const id = options.projectId ?? paths.identity.id;
  let targetPaths;
  try { targetPaths = projectStoragePaths(id); }
  catch (error: any) {
    throw new SetupFailure("identity", "SETUP_INVALID_PROJECT_ID", error?.message ?? String(error), "Use the exact project id reported by `hy-workflow setup --dry-run --json` or doctor.", { projectId: id });
  }
  const observe = () => {
    const registry = readRegistry(root);
    const deployment = readDeploymentById(id);
    if (options.removeGlobal) assertGlobalDeploymentGraph(root, registry);
    const preservedConfig = fs.existsSync(targetPaths.config);
    const exists = Boolean(registry.projects[id] || deployment || [targetPaths.stateDir, targetPaths.cacheDir, ...(preservedConfig ? [] : [targetPaths.configDir])].some(directory => fs.existsSync(directory)));
    const remainingAfter = Math.max(0, Object.keys(registry.projects).length - (registry.projects[id] ? 1 : 0));
    const ownership = readOwnership(root);
    if (options.removeGlobal && remainingAfter === 0) assertGlobalUnsetOwnership(root, deployment, ownership, selected);
    const hasExplicitOwnershipTarget = options.removeGlobal && remainingAfter === 0 && selected.some(adapter => Object.keys(ownership.clients[adapter.name] ?? {}).length > 0);
    return { registry, deployment, preservedConfig, exists, remainingAfter, ownership, hasExplicitOwnershipTarget };
  };
  const preview = observe();
  if (!preview.exists && !preview.hasExplicitOwnershipTarget) {
    return {
      ok: true,
      action: "unset",
      mode: "shared",
      projectId: id,
      projectRoot: paths.identity.root,
      clients: [],
      projectFilesChanged: [],
      localFilesChanged: [],
      remainingProjects: Object.keys(preview.registry.projects).length,
      dryRun: options.dryRun,
      removed: false,
      message: "No local deployment found; shared project files kept",
      artifactChanges: preflight.artifactChanges,
    };
  }
  if (options.dryRun) {
    return {
      ok: true,
      action: "unset",
      mode: preview.deployment?.mode ?? "shared",
      projectId: id,
      projectRoot: paths.identity.root,
      clients: [],
      projectFilesChanged: [],
      localFilesChanged: [],
      remainingProjects: preview.remainingAfter,
      dryRun: true,
      removed: preview.exists,
      message: preview.exists ? "Local deployment would be removed; shared project files kept" : "No local deployment found; shared project files kept",
      artifactChanges: preflight.artifactChanges,
    };
  }
  await internalSetupTestHooks().afterUnsetPreflightBeforeLock?.(root);
  const committed = await withUnsetCoordination(root, () => withSetupTransaction(root, "unset", transaction => {
    // Every state-dependent cleanup decision is recomputed while holding the
    // global setup transaction lock. The outer observation is preview only.
    const locked = observe();
    if (!locked.exists && !locked.hasExplicitOwnershipTarget) {
      return {
        result: {
          ok: true,
          action: "unset",
          mode: "shared",
          projectId: id,
          projectRoot: paths.identity.root,
          clients: [],
          projectFilesChanged: [],
          localFilesChanged: [],
          remainingProjects: Object.keys(locked.registry.projects).length,
          dryRun: false,
          removed: false,
          transactionId: transaction.id,
          message: "No local deployment found; shared project files kept",
          artifactChanges: preflight.artifactChanges,
        } satisfies SetupResult,
        incomplete: { cleanup: [], unresolvedClients: [], remainingOwnedClients: [] },
      };
    }
    const legacyConfig = fs.existsSync(targetPaths.config) ? fs.readFileSync(targetPaths.config, "utf-8") : null;
    transaction.capture([paths.registry, paths.clientOwnership]);
    const removedClients = options.removeGlobal && locked.remainingAfter === 0
      ? removeClients(root, selected, transaction)
      : { clients: [] as SetupResult["clients"], ownership: locked.ownership, mutations: [] as ClientMutation[] };
    let outcome: UnregisterOutcome | undefined;
    try {
      if (options.removeGlobal && locked.remainingAfter === 0) {
        writeOwnership(root, removedClients.ownership, transaction);
        transaction.markApplied([paths.clientOwnership]);
      }
      outcome = unregisterProject(
        root,
        id,
        registry => {
          transaction.prepareExpected(paths.registry, jsonHash(registry));
          setupFailpoint("registry");
        },
        () => transaction.markApplied([paths.registry]),
        {
          prepare: (target, tombstone) => transaction.prepareDirectoryRemoval(target, tombstone),
          staged: (target, tombstone) => transaction.markDirectoryStaged(target, tombstone),
        },
        { preserveConfig: legacyConfig !== null },
      );
      internalSetupTestHooks().afterUnsetRegistryWrite?.();
      // Keep staged state intact until every fallible unset check has passed.
      // A deterministic failure here must restore config, workflow state, scope,
      // docs graph and registry for both current-root and --project-id cleanup.
      setupFailpoint("postcondition");
      const cleanup: string[] = [];
      const remainingOwnedClients = ownedClients(removedClients.ownership);
      const recovery = [
        ...cleanup.map(file => `Remove staged unset directory after verifying the deployment is absent: ${file}`),
        ...(options.removeGlobal && locked.remainingAfter === 0 && remainingOwnedClients.length ? ["Run hy-workflow doctor --offline --json to reconcile remaining owned client entries."] : []),
      ];
      const result: SetupResult = {
        ok: true,
        action: "unset",
        mode: locked.deployment?.mode ?? "shared",
        projectId: id,
        projectRoot: paths.identity.root,
        clients: removedClients.clients,
        projectFilesChanged: [],
        localFilesChanged: [targetPaths.configDir, targetPaths.stateDir, targetPaths.cacheDir],
        remainingProjects: outcome.remaining,
        remainingOwnedClients,
        dryRun: false,
        removed: outcome.removed,
        transactionId: transaction.id,
        message: outcome.removed ? "Local deployment removed; shared project files kept" : "No local deployment found; shared project files kept",
        recovery: recovery.length ? recovery : undefined,
      };
      const unresolvedClients = removedClients.clients.filter(client => client.status === "recovery_required");
      return {
        result,
        incomplete: {
          cleanup,
          unresolvedClients,
          remainingOwnedClients: options.removeGlobal && locked.remainingAfter === 0 ? remainingOwnedClients : [],
        },
      };
    } catch (error) {
      rollbackRemoved(removedClients.mutations, transaction);
      try { outcome?.rollback(); }
      catch (rollbackError) { throw rollbackError; }
      throw error;
    }
  }, { reconcileClient: resource => reconcileClientResource(allAdapters, resource) }));
  const incomplete = committed.incomplete;
  if (incomplete.cleanup.length || incomplete.unresolvedClients.length || incomplete.remainingOwnedClients.length) {
    throw new SetupFailure(
      "unset",
      "SETUP_UNSET_INCOMPLETE",
      "Local deployment was removed, but one or more requested cleanup actions remain incomplete.",
      "Run hy-workflow doctor --offline --json, resolve the reported client or staged-directory evidence, then retry unset.",
      {
        projectId: id,
        completed: { registryRemoved: true, externalDeploymentRemoved: true, sharedProjectFilesKept: true },
        incomplete,
        transactionId: committed.result.transactionId,
      },
    );
  }
  return committed.result;
}

export async function executeSetup(
  root: string,
  options: SetupOptions,
  adapters?: ClientAdapter[],
  execution: { inspectDirectTools?: boolean } = {},
): Promise<SetupResult> {
  assertSafeRuntimeBoundary(root);
  const actualAdapters = adapters ?? createClientAdapters(root);
  const selected = selectedAdapters(options, actualAdapters);
  const inspectDirectTools = execution.inspectDirectTools ?? adapters === undefined;
  if (!options.dryRun && fs.existsSync(projectPaths(root).setupJournal)) {
    await withSetupTransaction(root, options.action, () => undefined, { reconcileClient: resource => reconcileClientResource(actualAdapters, resource) });
  }
  return options.action === "unset"
    ? executeUnset(root, options, selected, actualAdapters)
    : executeInstall(root, options, selected, actualAdapters, inspectDirectTools);
}
