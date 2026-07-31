import * as fs from "node:fs";
import * as path from "node:path";
import { readDeployment, readDeploymentById, readRegistry } from "../runtime/deployment.js";
import { findProjectRoot } from "../runtime/project.js";
import { projectPaths, userRoots } from "../runtime/user-paths.js";
import { clientSnapshotEquals } from "./clients/effective.js";
import { definitionEquals } from "./clients/index.js";
import { createClientAdapters, readOwnership } from "./operations.js";
import { inspectSetupTools } from "./preflight.js";
import { SHARED_PROJECT_FILES, sharedArtifactEvidence } from "./shared.js";
import { MCP_DEFINITIONS, type ServerName } from "./types.js";
import { redactDiagnosticValue } from "../errs/structured.js";

export type DoctorCheck = {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
  hint?: string;
  detail?: unknown;
};

export type DoctorResult = {
  ok: boolean;
  offline: boolean;
  projectRoot: string;
  projectId: string;
  checks: DoctorCheck[];
  summary: { pass: number; warn: number; fail: number };
};

function add(checks: DoctorCheck[], check: DoctorCheck): void {
  checks.push(check);
}

function failure(id: string, error: unknown, hint?: string): DoctorCheck {
  const value = error as any;
  return {
    id,
    status: "fail",
    message: value?.message ?? String(error),
    hint: value?.hint ?? hint,
    detail: value?.detail,
  };
}

function sameStrings(left: string[], right: string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function sameIdentity(left: unknown, right: unknown): boolean {
  const a = left as any;
  const b = right as any;
  return Boolean(a && b
    && a.id === b.id
    && a.root === b.root
    && a.gitCommonDir === b.gitCommonDir
    && (a.remote ?? null) === (b.remote ?? null));
}

function toolEvidenceMatches(recorded: unknown, live: unknown): boolean {
  const a = recorded as any;
  const b = live as any;
  return Boolean(a && b
    && a.command === b.command
    && a.executable === b.executable
    && a.version === b.version
    && a.catalogHash === b.catalogHash);
}

function globalDeploymentGraphIssues(registry: ReturnType<typeof readRegistry>): string[] {
  const projectsDir = path.join(userRoots().state, "projects");
  const deployments = new Map<string, NonNullable<ReturnType<typeof readDeploymentById>>>();
  const issues: string[] = [];
  if (fs.existsSync(projectsDir)) {
    for (const id of fs.readdirSync(projectsDir)) {
      if (!/^[a-f0-9]{24}$/.test(id)) continue;
      const directory = path.join(projectsDir, id);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(directory); }
      catch (error: any) { issues.push(`project ${id} state cannot be inspected: ${error?.message ?? String(error)}`); continue; }
      if (stat.isSymbolicLink()) { issues.push(`project ${id} state is a symlink: ${directory}`); continue; }
      if (!stat.isDirectory() || !fs.existsSync(path.join(directory, "deployment.json"))) continue;
      try {
        const deployment = readDeploymentById(id);
        if (!deployment) issues.push(`project ${id} has missing deployment evidence`);
        else {
          if (deployment.identity.id !== id) issues.push(`project ${id} deployment identity is ${deployment.identity.id}`);
          deployments.set(id, deployment);
        }
      } catch (error: any) {
        issues.push(`project ${id} deployment is unreadable: ${error?.message ?? String(error)}`);
      }
    }
  }
  for (const id of new Set([...Object.keys(registry.projects), ...deployments.keys()])) {
    const record = registry.projects[id];
    const deployment = deployments.get(id);
    if (!record || !deployment) {
      issues.push(`registry/deployment pair is incomplete for ${id}`);
      continue;
    }
    if (!sameIdentity(record, deployment.identity)
      || record.mode !== deployment.mode
      || !sameStrings(record.clients, deployment.clients)
      || record.updatedAt !== deployment.updatedAt) issues.push(`registry/deployment pair drifted for ${id}`);
  }
  return [...new Set(issues)];
}

export async function runSetupDoctor(root: string, options: { offline?: boolean } = {}): Promise<DoctorResult> {
  const projectRoot = findProjectRoot(root);
  const paths = projectPaths(projectRoot);
  const checks: DoctorCheck[] = [];
  add(checks, { id: "project.root", status: "pass", message: `Git project root: ${projectRoot}` });

  let registry: ReturnType<typeof readRegistry> | null = null;
  let registryRecord: ReturnType<typeof readRegistry>["projects"][string] | undefined;
  try {
    registry = readRegistry(projectRoot);
    registryRecord = registry.projects[paths.identity.id];
    add(checks, registryRecord
      ? { id: "registry", status: "pass", message: `Project is registered at revision ${registry.revision}.` }
      : { id: "registry", status: "warn", message: "Current project is not registered.", hint: "Run hy-workflow setup after resolving all failing checks." });
  } catch (error) { add(checks, failure("registry", error)); }

  if (registry) {
    const issues = globalDeploymentGraphIssues(registry);
    add(checks, issues.length
      ? { id: "coherence.global", status: "fail", message: "Global registry/deployment graph contains orphaned or drifted projects.", hint: "Preserve every listed registry and deployment file; reconcile these project ids before retrying global unset.", detail: { issues } }
      : { id: "coherence.global", status: "pass", message: "Every registered project has one matching external deployment manifest." });
  }

  let deployment: ReturnType<typeof readDeployment> = null;
  try {
    deployment = readDeployment(projectRoot);
    if (!deployment) add(checks, { id: "deployment", status: "warn", message: "No local deployment manifest exists.", hint: "Run hy-workflow setup." });
    else add(checks, {
      id: "deployment",
      status: "pass",
      message: deployment.schemaVersion === "3" && deployment.projectContract
        ? `Deployment ${deployment.setupVersion} uses the minimal project contract.`
        : `Legacy deployment ${deployment.setupVersion} remains compatible; repository injections are inert.`,
    });
  } catch (error) { add(checks, failure("deployment", error)); }

  if (registryRecord && !deployment) {
    add(checks, { id: "coherence.deployment", status: "fail", message: "Registry record exists but its external deployment manifest is missing.", hint: "Preserve the registry record and reconcile external state before setup or unset." });
  }

  let ownership: ReturnType<typeof readOwnership> | null = null;
  const ownershipExists = fs.existsSync(paths.clientOwnership);
  try {
    ownership = readOwnership(projectRoot);
    const count = Object.values(ownership.clients).reduce((sum, value) => sum + Object.keys(value ?? {}).length, 0);
    add(checks, { id: "ownership", status: "pass", message: `Ownership manifest revision ${ownership.revision} contains ${count} entries.` });
  } catch (error) { add(checks, failure("ownership", error)); }

  if (deployment?.schemaVersion === "3") {
    const identityCurrent = sameIdentity(deployment.identity, paths.identity);
    add(checks, identityCurrent
      ? { id: "coherence.identity", status: "pass", message: "Deployment identity matches the current Git project identity." }
      : { id: "coherence.identity", status: "fail", message: "Deployment identity does not match the current Git project identity.", hint: "Do not delete external state. Reconcile the project move or remote identity, then rerun setup.", detail: { deployment: deployment.identity, current: paths.identity } });
    const registryCoherent = Boolean(registryRecord
      && sameIdentity(registryRecord, deployment.identity)
      && registryRecord.mode === deployment.mode
      && sameStrings(registryRecord.clients, deployment.clients)
      && registryRecord.updatedAt === deployment.updatedAt);
    add(checks, registryCoherent
      ? { id: "coherence.registry", status: "pass", message: "Registry record matches deployment identity, clients, mode, and revision timestamp." }
      : { id: "coherence.registry", status: "fail", message: "Schema 3 deployment is missing its exact registry record or the record has drifted.", hint: "Preserve both files and rerun setup to reconcile them transactionally.", detail: { deployment: { identity: deployment.identity, clients: deployment.clients, mode: deployment.mode, updatedAt: deployment.updatedAt }, registry: registryRecord ?? null } });
    if (!ownershipExists) {
      add(checks, { id: "coherence.ownership", status: "fail", message: "Schema 3 deployment is missing its client ownership manifest.", hint: "Do not run destructive cleanup. Rerun setup with the declared clients to recreate ownership evidence safely." });
    } else if (ownership) {
      const missing = deployment.clients.flatMap(client => (Object.keys(MCP_DEFINITIONS) as ServerName[]).flatMap(server => {
        const entry = ownership!.clients[client]?.[server];
        return entry?.applied && definitionEquals(entry.desired, MCP_DEFINITIONS[server]) ? [] : [`${client}/${server}`];
      }));
      add(checks, missing.length
        ? { id: "coherence.ownership", status: "fail", message: `Ownership evidence is missing or drifted for: ${missing.join(", ")}.`, hint: "Preserve global client configuration and rerun setup for the declared clients.", detail: { missing } }
        : { id: "coherence.ownership", status: "pass", message: "Every declared client/server pair has matching desired ownership evidence." });
    }
    if (deployment.projectContract) {
      const expectedFiles = [...SHARED_PROJECT_FILES].sort();
      const recordedFiles = [...deployment.projectFiles].sort();
      const evidenceFiles = Object.keys(deployment.artifacts).sort();
      const surfaceCurrent = sameStrings(recordedFiles, expectedFiles) && sameStrings(evidenceFiles, expectedFiles);
      add(checks, surfaceCurrent
        ? { id: "artifacts.contract", status: "pass", message: "Minimal project artifact surface contains exactly the config and thin workflow." }
        : { id: "artifacts.contract", status: "fail", message: "Minimal project artifact surface or recorded evidence is incomplete.", hint: "Rerun setup after reviewing the exact two-file artifact diff.", detail: { expectedFiles, projectFiles: recordedFiles, evidenceFiles } });
      try {
        const live = sharedArtifactEvidence(projectRoot);
        for (const file of SHARED_PROJECT_FILES) {
          const recorded = deployment.artifacts[file];
          const current = live[file];
          add(checks, recorded && current && recorded.sha256 === current.sha256 && recorded.size === current.size
            ? { id: `artifact.${file}`, status: "pass", message: `${file} matches its recorded setup evidence.` }
            : { id: `artifact.${file}`, status: "fail", message: `${file} differs from its recorded setup evidence.`, hint: "Review the project-owned change, then rerun setup with exact artifact hashes if replacement is intended.", detail: { recorded: recorded ?? null, current: current ?? null } });
        }
      } catch (error) {
        add(checks, failure("artifacts.read", error, "Replace unsafe project artifact paths with normal files, then rerun doctor."));
      }
    }
  }

  if (fs.existsSync(paths.setupJournal)) {
    let detail: unknown;
    let hint = "Do not delete it. Retry setup for automatic CAS recovery, then rerun doctor.";
    try {
      const journal = JSON.parse(fs.readFileSync(paths.setupJournal, "utf-8"));
      const resources = Array.isArray(journal.clientResources) ? journal.clientResources.map((value: any) => typeof value === "string" ? { resource: value } : { resource: value?.resource, action: value?.action }) : [];
      detail = { id: journal.id, action: journal.action, phase: journal.phase, clientResources: resources, directoryResources: Array.isArray(journal.directoryResources) ? journal.directoryResources.length : 0 };
      const command = journal.action === "unset" ? "hy-workflow unset" : "hy-workflow setup";
      hint = journal.phase === "committed"
        ? `Do not delete it. Retry ${command} to finish committed tombstone cleanup, then rerun doctor.`
        : `Do not delete it. Retry ${command} to perform CAS rollback/reconciliation, then rerun doctor.`;
    } catch {
      detail = { unreadable: true };
      hint = "Do not delete or rewrite the unreadable journal. Preserve it and reconcile the listed external state manually.";
    }
    add(checks, { id: "transaction.journal", status: "fail", message: `Interrupted setup journal exists: ${paths.setupJournal}`, hint, detail });
  } else add(checks, { id: "transaction.journal", status: "pass", message: "No interrupted setup journal exists." });
  if (fs.existsSync(paths.setupLock)) {
    add(checks, { id: "transaction.lock", status: "warn", message: `Setup lock exists: ${paths.setupLock}`, hint: "If no setup process is active, wait one minute and retry setup for stale-lock recovery." });
  } else add(checks, { id: "transaction.lock", status: "pass", message: "No setup lock is held." });

  try {
    const tools = await inspectSetupTools(projectRoot);
    for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
      const tool = tools[server];
      const recorded = deployment?.schemaVersion === "3" ? deployment.tools[server] : undefined;
      add(checks, !tool
        ? { id: `tool.${server}`, status: "fail", message: `${server} direct binary was not verified.` }
        : deployment?.schemaVersion === "3" && !toolEvidenceMatches(recorded, tool)
          ? { id: `tool.${server}`, status: "fail", message: `${server} live binary evidence differs from the schema 3 deployment record.`, hint: "Review the installed package version/path, then rerun setup to record the verified binary.", detail: { recorded: recorded ?? null, live: tool } }
          : { id: `tool.${server}`, status: "pass", message: `${tool.command} ${tool.version}; MCP catalog ${tool.catalogHash?.slice(0, 12) ?? "unknown"}.`, detail: tool });
    }
  } catch (error) { add(checks, failure("tools", error)); }

  for (const adapter of createClientAdapters(projectRoot)) {
    let detection;
    try { detection = adapter.detect(); }
    catch (error) { add(checks, failure(`client.${adapter.name}`, error)); continue; }
    if (!detection.installed) {
      const declared = deployment?.schemaVersion === "3" && deployment.clients.includes(adapter.name);
      add(checks, { id: `client.${adapter.name}`, status: declared ? "fail" : "warn", message: `${adapter.name} is not installed or not on PATH.`, hint: declared ? "Reinstall the declared client before global unset, or reconcile its owned definitions manually." : undefined });
      continue;
    }
    add(checks, { id: `client.${adapter.name}`, status: "pass", message: `${adapter.name} ${detection.version ?? "unknown version"} is installed.` });
    for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
      const snapshot = adapter.inspect(server);
      const effective = definitionEquals(snapshot.definition, MCP_DEFINITIONS[server]) && snapshot.enabled !== false && snapshot.state !== "shadowed";
      add(checks, effective
        ? { id: `client.${adapter.name}.${server}`, status: "pass", message: `${server} is effective from ${snapshot.source ?? snapshot.scope ?? "client configuration"}.`, detail: { source: snapshot.source, scope: snapshot.scope, state: snapshot.state } }
        : { id: `client.${adapter.name}.${server}`, status: deployment?.schemaVersion === "3" && deployment.clients.includes(adapter.name) ? "fail" : "warn", message: `${server} is not an effective direct definition for ${adapter.name}.`, hint: snapshot.state === "shadowed" ? "Migrate the reported project-owned definition explicitly; setup will not delete it." : "Run hy-workflow setup for this client.", detail: snapshot });
      if (deployment?.schemaVersion === "3" && deployment.clients.includes(adapter.name)) {
        const applied = ownership?.clients[adapter.name]?.[server]?.applied;
        add(checks, applied && clientSnapshotEquals(snapshot, applied)
          ? { id: `client.${adapter.name}.${server}.ownership`, status: "pass", message: `${server} matches its applied ownership fingerprint.` }
          : { id: `client.${adapter.name}.${server}.ownership`, status: "fail", message: `${server} differs from its applied ownership fingerprint.`, hint: "Preserve the user edit and reconcile the client target explicitly before setup or unset.", detail: { applied: applied ?? null, current: snapshot } });
      }
      if (adapter.name === "codex" && deployment?.schemaVersion === "3" && deployment.clients.includes("codex") && effective) {
        const raw = snapshot.raw as any;
        const timeoutsCurrent = Number(raw?.startup_timeout_sec) === 60 && Number(raw?.tool_timeout_sec) === 300;
        add(checks, timeoutsCurrent
          ? { id: `client.codex.${server}.timeouts`, status: "pass", message: `${server} uses Codex startup/tool timeouts 60/300.` }
          : { id: `client.codex.${server}.timeouts`, status: "fail", message: `${server} Codex timeouts are not startup=60/tool=300.`, hint: "Rerun setup for Codex to restore bounded MCP startup and tool timeouts.", detail: { startup_timeout_sec: raw?.startup_timeout_sec, tool_timeout_sec: raw?.tool_timeout_sec } });
      }
    }
  }

  const summary = {
    pass: checks.filter(item => item.status === "pass").length,
    warn: checks.filter(item => item.status === "warn").length,
    fail: checks.filter(item => item.status === "fail").length,
  };
  const publicChecks = checks.map(check => redactDiagnosticValue(check) as DoctorCheck);
  return { ok: summary.fail === 0, offline: options.offline ?? false, projectRoot, projectId: paths.identity.id, checks: publicChecks, summary };
}

export async function runDoctorCli(argv: string[] = [], root = process.cwd()): Promise<number> {
  const allowed = new Set(["--offline", "--json"]);
  const unknown = argv.filter(value => !allowed.has(value));
  if (unknown.length) {
    process.stderr.write(`hy-workflow doctor: unknown option(s): ${unknown.join(", ")}\n`);
    return 1;
  }
  try {
    const result = await runSetupDoctor(root, { offline: argv.includes("--offline") });
    if (argv.includes("--json")) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else {
      for (const check of result.checks) process.stdout.write(`${check.status.toUpperCase()} ${check.id}: ${check.message}${check.hint ? `\n  ${check.hint}` : ""}\n`);
      process.stdout.write(`doctor: ${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail\n`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    const check = failure("doctor", error);
    const payload = { ok: false, offline: argv.includes("--offline"), checks: [check], summary: { pass: 0, warn: 0, fail: 1 } };
    if (argv.includes("--json")) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    else process.stderr.write(`hy-workflow doctor: ${check.message}${check.hint ? `\n${check.hint}` : ""}\n`);
    return 1;
  }
}
