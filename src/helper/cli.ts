import * as fs from "node:fs";
import { findProjectRoot } from "../runtime/project.js";
import { readDeployment, type ClientName } from "../runtime/deployment.js";
import { projectPaths } from "../runtime/user-paths.js";
import {
  detectGlobalSkillTargets,
  getHelperSkillStatus,
  helperSkillPaths,
  installHelperSkills,
  removeHelperSkills,
  updateHelperSkills,
  type DetectedHelperSkillTarget,
  type HelperSkillProjectionPreference,
  type HelperSkillStatus,
  type HelperSkillTarget,
} from "./skills.js";
import {
  assertHelperResourcesExternal,
  getHelperProjectStatus,
  registerHelperProject,
  type HelperProjectRegistration,
} from "./project.js";
import { withHelperOperationLock } from "./operation-lock.js";
import {
  HELPER_CLI_CLIENTS,
  HELPER_CLI_SCHEMA,
  HELPER_CLI_VERSION,
  HelperCliInputError,
  helperCommandArgv,
  isHelperCliCommand,
  parseHelperCliArgs,
  type HelperCliCommand,
  type HelperCliDependencies,
  type HelperCliEnvelope,
  type HelperCliRunResult,
  type ParsedHelperCli,
} from "./cli-contract.js";
import {
  completedLayerNames,
  notRunLayers,
  partialEnvelope,
  projectAttentionEnvelope,
  projectLayer,
  skillLayer,
  skillStatusLayer,
  structuredError,
} from "./cli-presentation.js";

export {
  HELPER_CLI_CLIENTS,
  HELPER_CLI_COMMANDS,
  HELPER_CLI_SCHEMA,
  HELPER_CLI_VERSION,
  HelperCliInputError,
  helperCommandArgv,
  parseHelperCliArgs,
  type HelperCliCommand,
  type HelperCliDependencies,
  type HelperCliEnvelope,
  type HelperCliError,
  type HelperCliLayer,
  type HelperCliRunResult,
  type ParsedHelperCli,
} from "./cli-contract.js";

function sameClients(left: readonly ClientName[], right: readonly ClientName[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function exactTargets(
  parsed: ParsedHelperCli,
  skillStatus: HelperSkillStatus,
  detected: DetectedHelperSkillTarget[],
  deploymentClients: ClientName[],
): { clients: ClientName[]; targets: HelperSkillTarget[]; mode: HelperSkillProjectionPreference } {
  const manifest = skillStatus.manifest;
  if (manifest) {
    const clients = manifest.targets.map(target => target.agent);
    if (parsed.clients && !sameClients(parsed.clients, clients)) {
      throw new HelperCliInputError(
        "HELPER_TARGET_SET_IMMUTABLE",
        "An installed Skill bundle keeps its exact Agent target set; remove and reinstall to choose different clients.",
      );
    }
    if (parsed.mode && manifest.targets.some(target => target.preference !== parsed.mode)) {
      throw new HelperCliInputError(
        "HELPER_MODE_IMMUTABLE",
        "An installed Skill bundle keeps its projection preference; remove and reinstall to choose a different mode.",
      );
    }
    return {
      clients: [...clients].sort() as ClientName[],
      targets: manifest.targets.map(target => ({ agent: target.agent, skillsDir: target.skillsDir })),
      mode: manifest.targets[0]?.preference ?? "auto",
    };
  }

  if (parsed.command === "update") {
    throw new HelperCliInputError("HELPER_SKILLS_NOT_INSTALLED", "helper update requires an existing owned Skill bundle; run helper install first.");
  }
  const selected = parsed.clients ?? HELPER_CLI_CLIENTS.filter(client =>
    deploymentClients.includes(client) || detected.some(target => target.agent === client && target.detected),
  );
  if (!selected.length) {
    throw new HelperCliInputError(
      "HELPER_CLIENTS_NOT_DETECTED",
      "No Agent was selected or detected. Pass --clients with the exact target clients.",
    );
  }
  const targets = selected.map(client => {
    const target = detected.find(candidate => candidate.agent === client);
    if (!target) throw new HelperCliInputError("HELPER_CLIENT_PATH_UNAVAILABLE", `No global Skill directory is known for ${client}.`);
    return { agent: target.agent, skillsDir: target.skillsDir };
  });
  return { clients: [...selected], targets, mode: parsed.mode ?? "auto" };
}

function ownershipClients(root: string, selected: ClientName[]): ClientName[] {
  const file = projectPaths(root).clientOwnership;
  if (!fs.existsSync(file)) return [];
  try {
    const ownership = JSON.parse(fs.readFileSync(file, "utf8")) as {
      schemaVersion?: unknown;
      clients?: Partial<Record<ClientName, Partial<Record<string, unknown>>>>;
    };
    if (ownership.schemaVersion !== "1" || !ownership.clients || typeof ownership.clients !== "object") {
      throw new Error("unsupported ownership manifest");
    }
    return selected.filter(client => Boolean(ownership.clients?.[client]?.["hy-workflow"]));
  } catch (error) {
    const failure = new Error(`Legacy MCP ownership cannot be read safely: ${file}`);
    Object.assign(failure, {
      type: "helper",
      subtype: "mcp_ownership",
      code: "HELPER_MCP_OWNERSHIP_INVALID",
      retryable: false,
      detail: { file, cause: error instanceof Error ? error.message : String(error) },
    });
    throw failure;
  }
}

async function executeInstallOrUpdate(
  parsed: ParsedHelperCli,
  root: string,
  dependencies: HelperCliDependencies,
): Promise<HelperCliEnvelope> {
  const layers = notRunLayers();
  const paths = dependencies.skillPaths ?? helperSkillPaths();
  const bundleRoot = dependencies.bundleRoot;
  const detected = dependencies.detectedTargets ?? detectGlobalSkillTargets();
  let clients: ClientName[] = [];
  let installedSkillManifest: HelperSkillStatus["manifest"] = null;
  try {
    (dependencies.projectStatus ?? getHelperProjectStatus)(root);
  } catch (error) {
    layers.project = { status: "failed", error: structuredError(error), projectFilesChanged: [] };
    return partialEnvelope(parsed, root, clients, layers, error);
  }

  try {
    const before = getHelperSkillStatus({ paths, ...(bundleRoot ? { bundleRoot } : {}) });
    const deployment = readDeployment(root);
    const selection = exactTargets(parsed, before, detected, deployment?.clients ?? []);
    clients = selection.clients;
    assertHelperResourcesExternal(root, paths, selection.targets);
    const result = parsed.command === "install"
      ? installHelperSkills({
          paths,
          ...(bundleRoot ? { bundleRoot } : {}),
          ...(before.manifest ? {} : { targets: selection.targets, mode: selection.mode }),
          ...(dependencies.skillHooks ? { hooks: dependencies.skillHooks } : {}),
        })
      : updateHelperSkills({
          paths,
          ...(bundleRoot ? { bundleRoot } : {}),
          repair: parsed.repair,
          ...(dependencies.skillHooks ? { hooks: dependencies.skillHooks } : {}),
        });
    layers.skills = skillLayer(result);
    installedSkillManifest = result.manifest;
  } catch (error) {
    layers.skills = { status: "failed", error: structuredError(error) };
    return partialEnvelope(parsed, root, clients, layers, error);
  }

  let registration: HelperProjectRegistration;
  try {
    const register = dependencies.registerProject ?? registerHelperProject;
    registration = await register(root, clients);
    layers.project = projectLayer(registration);
  } catch (error) {
    layers.project = { status: "failed", error: structuredError(error), projectFilesChanged: [] };
    return partialEnvelope(parsed, root, clients, layers, error);
  }
  if (registration.readiness.state === "attention") {
    return projectAttentionEnvelope(parsed, root, clients, layers, registration.readiness);
  }

  try {
    const owned = ownershipClients(root, clients);
    if (!owned.length) {
      layers.mcp = { status: "unchanged", clients: [], remainingOwnedClients: [] };
    } else {
      // Load the legacy compatibility kernel only when an exactly owned MCP
      // entry actually needs retirement. Fresh CLI+Skill installs never load it.
      const operations = await import("../setup/operations.js");
      const retire = dependencies.retireWorkflowMcp ?? operations.retireOwnedWorkflowMcp;
      const adapters = dependencies.adapters ?? operations.createClientAdapters(root);
      const currentSkills = getHelperSkillStatus({ paths, ...(bundleRoot ? { bundleRoot } : {}) });
      const exactManifest = currentSkills.state === "healthy"
        && installedSkillManifest !== null
        && currentSkills.manifest !== null
        && JSON.stringify(currentSkills.manifest) === JSON.stringify(installedSkillManifest);
      if (!exactManifest) {
        const error = new Error("The installed Skill manifest changed before legacy MCP retirement.");
        Object.assign(error, {
          code: "HELPER_SKILL_STATE_CHANGED",
          type: "helper",
          subtype: "mcp_retirement",
          retryable: true,
          detail: {
            skillState: currentSkills.state,
            findings: currentSkills.findings,
          },
        });
        throw error;
      }
      const retired = await retire(root, owned, adapters);
      const unresolved = retired.clients.filter(client => client.status === "recovery_required");
      const remainingWorkflowMcpClients = ownershipClients(root, owned);
      layers.mcp = {
        status: unresolved.length || remainingWorkflowMcpClients.length ? "partial" : "retired",
        clients: retired.clients,
        remainingOwnedClients: retired.remainingOwnedClients,
        remainingWorkflowMcpClients,
        ownershipPath: retired.ownershipPath,
        transactionId: retired.transactionId,
      };
      if (layers.mcp.status === "partial") {
        const error = new Error("Some owned hy-workflow MCP entries could not be retired safely.");
        Object.assign(error, { code: "HELPER_MCP_RETIREMENT_INCOMPLETE", type: "helper", subtype: "mcp_retirement", retryable: true });
        return partialEnvelope(parsed, root, clients, layers, error);
      }
    }
  } catch (error) {
    layers.mcp = { status: "failed", error: structuredError(error) };
    return partialEnvelope(parsed, root, clients, layers, error);
  }

  return {
    schema: HELPER_CLI_SCHEMA,
    version: HELPER_CLI_VERSION,
    command: parsed.command,
    ok: true,
    status: "completed",
    projectRoot: root,
    clients,
    layers,
    projectFilesChanged: [],
  };
}

async function executeStatus(
  parsed: ParsedHelperCli,
  root: string,
  dependencies: HelperCliDependencies,
): Promise<HelperCliEnvelope> {
  const layers = notRunLayers();
  try {
    const paths = dependencies.skillPaths ?? helperSkillPaths();
    const skills = getHelperSkillStatus({ paths, ...(dependencies.bundleRoot ? { bundleRoot: dependencies.bundleRoot } : {}) });
    layers.skills = skillStatusLayer(skills);
    const project = (dependencies.projectStatus ?? getHelperProjectStatus)(root);
    layers.project = projectLayer(project);
    const clients = skills.manifest?.targets.map(target => target.agent).sort() as ClientName[] ?? [];
    if (project.readiness?.state === "attention") {
      return projectAttentionEnvelope(parsed, root, clients, layers, project.readiness);
    }
    const owned = ownershipClients(root, clients);
    layers.mcp = {
      status: owned.length ? "retirement_pending" : "unchanged",
      ownedWorkflowMcpClients: owned,
      docsGardenerPreserved: true,
    };
    const attention = skills.state !== "healthy" || project.state !== "registered" || owned.length > 0;
    return {
      schema: HELPER_CLI_SCHEMA,
      version: HELPER_CLI_VERSION,
      command: parsed.command,
      ok: !attention,
      status: attention ? "attention" : "completed",
      projectRoot: root,
      clients,
      layers,
      projectFilesChanged: [],
      ...(attention ? {
        recovery: {
          command: "install",
          argv: ["hy-workflow", "helper", "install", "--json"],
          completedLayers: completedLayerNames(layers),
          reason: "HELPER_STATUS_ATTENTION",
        },
      } : {}),
    };
  } catch (error) {
    return partialEnvelope(parsed, root, [], layers, error);
  }
}

async function executeRemove(
  parsed: ParsedHelperCli,
  root: string,
  dependencies: HelperCliDependencies,
): Promise<HelperCliEnvelope> {
  const layers = notRunLayers();
  const paths = dependencies.skillPaths ?? helperSkillPaths();
  let clients: ClientName[] = [];
  try {
    const before = getHelperSkillStatus({ paths, ...(dependencies.bundleRoot ? { bundleRoot: dependencies.bundleRoot } : {}) });
    clients = before.manifest?.targets.map(target => target.agent).sort() as ClientName[] ?? [];
    const targets = before.manifest?.targets.map(target => ({ agent: target.agent, skillsDir: target.skillsDir })) ?? [];
    assertHelperResourcesExternal(root, paths, targets);
    const project = (dependencies.projectStatus ?? getHelperProjectStatus)(root);
    layers.project = { ...projectLayer(project), status: "preserved", localFilesChanged: [], projectFilesChanged: [] };
    layers.mcp = { status: "preserved", restored: false, docsGardenerPreserved: true };
    const removed = removeHelperSkills({
      paths,
      ...(dependencies.skillHooks ? { hooks: dependencies.skillHooks } : {}),
    });
    layers.skills = skillLayer(removed);
    return {
      schema: HELPER_CLI_SCHEMA,
      version: HELPER_CLI_VERSION,
      command: parsed.command,
      ok: true,
      status: "completed",
      projectRoot: root,
      clients,
      layers,
      projectFilesChanged: [],
    };
  } catch (error) {
    if (layers.skills.status === "not_run") layers.skills = { status: "failed", error: structuredError(error) };
    return partialEnvelope(parsed, root, clients, layers, error);
  }
}

export async function executeHelperCli(
  parsed: ParsedHelperCli,
  dependencies: HelperCliDependencies = {},
): Promise<HelperCliEnvelope> {
  const root = findProjectRoot(dependencies.cwd);
  if (parsed.command === "status") return executeStatus(parsed, root, dependencies);
  const paths = dependencies.skillPaths ?? helperSkillPaths();
  assertHelperResourcesExternal(root, paths);
  return withHelperOperationLock(paths, () => parsed.command === "remove"
    ? executeRemove(parsed, root, dependencies)
    : executeInstallOrUpdate(parsed, root, dependencies));
}

function parseFailure(command: HelperCliCommand | null, error: unknown): HelperCliEnvelope {
  return {
    schema: HELPER_CLI_SCHEMA,
    version: HELPER_CLI_VERSION,
    command,
    ok: false,
    status: "failed",
    projectRoot: null,
    clients: [],
    layers: notRunLayers(),
    projectFilesChanged: [],
    error: structuredError(error),
  };
}

export async function runHelperCli(
  argv: readonly string[],
  dependencies: HelperCliDependencies = {},
): Promise<HelperCliRunResult> {
  let command: HelperCliCommand | null = argv[0] && isHelperCliCommand(argv[0]) ? argv[0] : null;
  try {
    const parsed = parseHelperCliArgs(argv);
    command = parsed.command;
    const envelope = await executeHelperCli(parsed, dependencies);
    return { exitCode: envelope.ok ? 0 : 1, stdout: `${JSON.stringify(envelope)}\n`, envelope };
  } catch (error) {
    const envelope = parseFailure(command, error);
    return { exitCode: 1, stdout: `${JSON.stringify(envelope)}\n`, envelope };
  }
}
