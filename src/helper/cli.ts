import {
  detectGlobalSkillTargets,
  getHelperSkillStatus,
  helperSkillPaths,
  installHelperSkills,
  removeHelperSkills,
  updateHelperSkills,
  type DetectedHelperSkillTarget,
  type HelperSkillAgent,
  type HelperSkillOperationResult,
  type HelperSkillProjectionPreference,
  type HelperSkillStatus,
  type HelperSkillTarget,
} from "./skills.js";
import { readManifest } from "./skill-manifest.js";
import {
  HELPER_CLI_CLIENTS,
  HELPER_CLI_SCHEMA,
  HELPER_CLI_VERSION,
  HelperCliInputError,
  isHelperCliCommand,
  parseHelperCliArgs,
  type HelperCliCommand,
  type HelperCliDependencies,
  type HelperCliEnvelope,
  type HelperCliRunResult,
  type ParsedHelperCli,
} from "./cli-contract.js";
import {
  failedEnvelope,
  skillLayer,
  skillStatusLayer,
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

type ClientName = HelperSkillAgent;

function sameClients(left: readonly ClientName[], right: readonly ClientName[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function exactTargets(
  parsed: ParsedHelperCli,
  skillStatus: HelperSkillStatus,
  detected: DetectedHelperSkillTarget[],
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
    throw new HelperCliInputError(
      "HELPER_SKILLS_NOT_INSTALLED",
      "helper update requires an existing owned Skill bundle; run helper install first.",
    );
  }

  const selected = parsed.clients ?? HELPER_CLI_CLIENTS.filter(client =>
    detected.some(target => target.agent === client && target.detected),
  );
  if (!selected.length) {
    throw new HelperCliInputError(
      "HELPER_CLIENTS_NOT_DETECTED",
      "No Agent was selected or detected. Pass --clients with the exact target clients.",
    );
  }
  const targets = selected.map(client => {
    const target = detected.find(candidate => candidate.agent === client);
    if (!target) {
      throw new HelperCliInputError(
        "HELPER_CLIENT_PATH_UNAVAILABLE",
        `No global Skill directory is known for ${client}.`,
      );
    }
    return { agent: target.agent, skillsDir: target.skillsDir };
  });
  return { clients: [...selected], targets, mode: parsed.mode ?? "auto" };
}

function completedEnvelope(
  parsed: ParsedHelperCli,
  clients: ClientName[],
  result: HelperSkillOperationResult,
): HelperCliEnvelope {
  return {
    schema: HELPER_CLI_SCHEMA,
    version: HELPER_CLI_VERSION,
    command: parsed.command,
    ok: true,
    status: "completed",
    clients,
    skills: skillLayer(result),
    changedPaths: result.changes,
  };
}

function executeInstallOrUpdate(
  parsed: ParsedHelperCli,
  dependencies: HelperCliDependencies,
): HelperCliEnvelope {
  const paths = dependencies.skillPaths ?? helperSkillPaths();
  const detected = dependencies.detectedTargets ?? detectGlobalSkillTargets();
  const before = getHelperSkillStatus({
    paths,
    ...(dependencies.bundleRoot ? { bundleRoot: dependencies.bundleRoot } : {}),
  });
  const selection = exactTargets(parsed, before, detected);
  const options = {
    paths,
    ...(dependencies.bundleRoot ? { bundleRoot: dependencies.bundleRoot } : {}),
    ...(dependencies.skillHooks ? { hooks: dependencies.skillHooks } : {}),
  };
  const result = parsed.command === "install"
    ? installHelperSkills({
        ...options,
        ...(before.manifest ? {} : { targets: selection.targets, mode: selection.mode }),
      })
    : updateHelperSkills({
        ...options,
        repair: parsed.repair,
      });
  return completedEnvelope(parsed, selection.clients, result);
}

function executeStatus(
  parsed: ParsedHelperCli,
  dependencies: HelperCliDependencies,
): HelperCliEnvelope {
  const paths = dependencies.skillPaths ?? helperSkillPaths();
  const status = getHelperSkillStatus({
    paths,
    ...(dependencies.bundleRoot ? { bundleRoot: dependencies.bundleRoot } : {}),
  });
  const clients = (status.manifest?.targets.map(target => target.agent).sort() ?? []) as ClientName[];
  const attention = status.state === "drifted" || status.state === "unmanaged";
  return {
    schema: HELPER_CLI_SCHEMA,
    version: HELPER_CLI_VERSION,
    command: parsed.command,
    ok: true,
    status: attention ? "attention" : "completed",
    clients,
    skills: skillStatusLayer(status),
    changedPaths: [],
  };
}

function executeRemove(
  parsed: ParsedHelperCli,
  dependencies: HelperCliDependencies,
): HelperCliEnvelope {
  const paths = dependencies.skillPaths ?? helperSkillPaths();
  const manifest = readManifest(paths);
  const clients = (manifest?.targets.map(target => target.agent).sort() ?? []) as ClientName[];
  const result = removeHelperSkills({
    paths,
    ...(dependencies.skillHooks ? { hooks: dependencies.skillHooks } : {}),
  });
  return completedEnvelope(parsed, clients, result);
}

export async function executeHelperCli(
  parsed: ParsedHelperCli,
  dependencies: HelperCliDependencies = {},
): Promise<HelperCliEnvelope> {
  if (parsed.command === "status") return executeStatus(parsed, dependencies);
  if (parsed.command === "remove") return executeRemove(parsed, dependencies);
  return executeInstallOrUpdate(parsed, dependencies);
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
    const envelope = failedEnvelope(command, [], error);
    return { exitCode: 1, stdout: `${JSON.stringify(envelope)}\n`, envelope };
  }
}
