import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  UNIFIED_CONFIG_FILE,
  projectRuntimeConfigSource,
  resolveRuntimeConfig,
  validateRuntimeConfigValue,
  type JsonObject,
} from "../config.js";
import { SETUP_VERSION } from "../bootstrap.js";
import {
  readDeployment,
  writeDeployment,
  type ClientName,
  type DeploymentManifest,
  type LegacyDeploymentManifest,
} from "../runtime/deployment.js";
import { assertSafeRuntimeBoundary } from "../runtime/boundary.js";
import {
  atomicWriteJson,
  projectPaths,
  sameProjectCheckoutIdentity,
} from "../runtime/user-paths.js";
import { withSetupTransaction } from "../setup/transaction.js";
import type { HelperSkillPaths, HelperSkillTarget } from "./skills.js";
import {
  projectReadinessFacts,
  projectReadinessIssues,
  type ProjectReadinessIssueFact,
} from "../tools/init.js";
import {
  IDENTITY_RECONCILIATION_REQUIRED,
  assertDeploymentIdentity,
  assertDeploymentRegistryPair,
  assertNoOrphanRegistryRecord,
  movedIdentityPlan,
  reconcileMovedProjectIdentity,
} from "./project-identity.js";


export type HelperProjectReadinessIssue = ProjectReadinessIssueFact;

export type HelperProjectReadiness = {
  state: "ready" | "attention";
  configExists: boolean;
  authority: ReturnType<typeof resolveRuntimeConfig>["authority"];
  issues: HelperProjectReadinessIssue[];
};
export type HelperProjectRegistration = {
  action: "registered" | "preserved" | "attention";
  projectId: string;
  projectRoot: string;
  configPath: string;
  deploymentPath: string;
  registryPath: string;
  workflowStatePath: string;
  scopePath: string;
  deployment: DeploymentManifest | LegacyDeploymentManifest;
  readiness: HelperProjectReadiness;
  localFilesChanged: string[];
  projectFilesChanged: [];
};

export type HelperProjectStatus = {
  state: "registered" | "unregistered" | "attention";
  projectId: string;
  projectRoot: string;
  configPath: string;
  deploymentPath: string;
  registryPath: string;
  workflowStatePath: string;
  scopePath: string;
  configExists: boolean;
  workflowStateExists: boolean;
  scopeExists: boolean;
  deployment: DeploymentManifest | LegacyDeploymentManifest | null;
  readiness: HelperProjectReadiness | null;
  projectFilesChanged: [];
};

export class HelperProjectError extends Error {
  readonly type = "helper" as const;
  readonly subtype = "project_registration" as const;
  readonly retryable = false;

  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HelperProjectError";
  }
}

function jsonHash(value: unknown): string {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`).digest("hex");
}

function canonicalPotential(target: string): string {
  let cursor = path.resolve(target);
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  let resolved: string;
  try { resolved = fs.realpathSync.native(cursor); }
  catch (error: any) {
    throw new HelperProjectError(
      "HELPER_PATH_UNSAFE",
      `Helper resource path cannot be resolved safely: ${target}`,
      { target, cause: error?.message ?? String(error) },
    );
  }
  return path.resolve(resolved, ...suffix);
}

function inside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Fail before mutation if any helper-owned resource would enter the project or its Git metadata. */
export function assertHelperResourcesExternal(
  root: string,
  skillPaths: HelperSkillPaths,
  targets: HelperSkillTarget[] = [],
): void {
  assertSafeRuntimeBoundary(root);
  const project = projectPaths(root);
  const projectRoot = canonicalPotential(project.identity.root);
  const gitCommonDir = canonicalPotential(project.identity.gitCommonDir);
  const resources = [
    skillPaths.dataRoot,
    skillPaths.stateRoot,
    skillPaths.ssotRoot,
    skillPaths.manifestPath,
    skillPaths.lockPath,
    ...targets.map(target => target.skillsDir),
  ].map(value => ({ configured: value, canonical: canonicalPotential(value) }));
  const unsafe = resources.filter(resource => inside(projectRoot, resource.canonical) || inside(gitCommonDir, resource.canonical));
  if (unsafe.length) {
    throw new HelperProjectError(
      "HELPER_PATH_UNSAFE",
      "Helper user resources must remain outside the project and its Git metadata.",
      { projectRoot, gitCommonDir, unsafe },
    );
  }
}

function identityReconciliationReadiness(paths: ReturnType<typeof projectPaths>): HelperProjectReadiness {
  return {
    state: "attention",
    configExists: fs.existsSync(paths.config),
    authority: { kind: "external", source: paths.config },
    issues: [{
      code: IDENTITY_RECONCILIATION_REQUIRED,
      message: "The project checkout moved; external deployment identity must be reconciled transactionally before workflow commands continue.",
    }],
  };
}


function completeExternalConfig(root: string): JsonObject {
  const resolved = resolveRuntimeConfig(root);
  if (resolved.issues.length) {
    throw new HelperProjectError(
      "HELPER_PROJECT_CONFIG_INVALID",
      "A complete external project configuration could not be established.",
      { authority: resolved.authority, issues: resolved.issues },
    );
  }
  const candidate = resolved.authority.kind === "legacy-detected"
    ? {
        ...resolved.config,
        policy: {
          ...((resolved.config.policy && typeof resolved.config.policy === "object" && !Array.isArray(resolved.config.policy))
            ? resolved.config.policy
            : {}),
          profile: "standard",
        },
      }
    : resolved.config;
  const validated = validateRuntimeConfigValue(root, candidate);
  if (validated.issues.length) {
    throw new HelperProjectError(
      "HELPER_PROJECT_CONFIG_INVALID",
      "The external project configuration produced during migration is invalid.",
      { authority: resolved.authority, issues: validated.issues },
    );
  }
  return validated.config;
}

function legacyDeploymentHasValidProjectConfig(
  root: string,
  deployment: DeploymentManifest | LegacyDeploymentManifest,
): boolean {
  if (!deployment.projectFiles.includes(UNIFIED_CONFIG_FILE)) return false;
  const source = path.join(root, UNIFIED_CONFIG_FILE);
  if (!fs.existsSync(source)) return false;

  let raw: JsonObject;
  try {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("legacy project config must be a regular file");
    }
    const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("legacy project config must be a JSON object");
    }
    raw = parsed as JsonObject;
  } catch (error) {
    throw new HelperProjectError(
      "HELPER_PROJECT_CONFIG_INVALID",
      `The legacy project configuration cannot be projected safely: ${source}`,
      { source, cause: error instanceof Error ? error.message : String(error) },
    );
  }

  const validated = validateRuntimeConfigValue(root, raw);
  if (validated.issues.length) {
    throw new HelperProjectError(
      "HELPER_PROJECT_CONFIG_INVALID",
      "The legacy project configuration is invalid and was not projected.",
      { source, issues: validated.issues },
    );
  }
  return true;
}

function inspectProjectReadiness(root: string): HelperProjectReadiness {
  const paths = projectPaths(root);
  let authority: HelperProjectReadiness["authority"] = {
    kind: "external",
    source: paths.config,
  };

  // Runtime resolution deliberately supports legacy detection. A registered
  // project must instead prove that its external authority still exists.
  if (!fs.existsSync(paths.config)) {
    return {
      state: "attention",
      configExists: false,
      authority,
      issues: [{
        code: "HELPER_PROJECT_CONFIG_INVALID",
        message: `The authoritative external project configuration is missing: ${paths.config}`,
      }],
    };
  }

  try {
    const resolved = resolveRuntimeConfig(root);
    authority = resolved.authority;
    if (resolved.issues.length) {
      return {
        state: "attention",
        configExists: true,
        authority,
        issues: resolved.issues.map(message => ({
          code: "HELPER_PROJECT_CONFIG_INVALID",
          message,
        })),
      };
    }

    const issues = projectReadinessFacts(projectReadinessIssues(root, resolved.config));
    return {
      state: issues.length ? "attention" : "ready",
      configExists: true,
      authority,
      issues,
    };
  } catch (error) {
    return {
      state: "attention",
      configExists: true,
      authority,
      issues: [{
        code: "HELPER_PROJECT_CONFIG_INVALID",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

export function getHelperProjectStatus(root: string): HelperProjectStatus {
  const paths = projectPaths(root);
  const deployment = readDeployment(root);
  let readiness: HelperProjectReadiness | null = null;
  if (deployment && !sameProjectCheckoutIdentity(deployment.identity, paths.identity)) {
    movedIdentityPlan(root, paths, deployment);
    assertDeploymentRegistryPair(root, deployment);
    readiness = identityReconciliationReadiness(paths);
  } else if (deployment) {
    assertDeploymentIdentity(root, deployment);
    assertDeploymentRegistryPair(root, deployment);
    readiness = inspectProjectReadiness(root);
  } else {
    assertNoOrphanRegistryRecord(root, paths);
  }
  return {
    state: !deployment
      ? "unregistered"
      : readiness?.state === "attention"
        ? "attention"
        : "registered",
    projectId: paths.identity.id,
    projectRoot: paths.identity.root,
    configPath: paths.config,
    deploymentPath: paths.deployment,
    registryPath: paths.registry,
    workflowStatePath: paths.workflowState,
    scopePath: paths.scope,
    configExists: fs.existsSync(paths.config),
    workflowStateExists: fs.existsSync(paths.workflowState),
    scopeExists: fs.existsSync(paths.scope),
    deployment,
    readiness,
    projectFilesChanged: [],
  };
}

/**
 * Register one Git project using external state only. Same-checkout state is
 * byte-preserved. A proven move reconciles only deployment/registry identity;
 * config, workflow state, scope, cache, DocsGraph and client ownership stay unchanged.
 */
export async function registerHelperProject(
  root: string,
  clients: ClientName[],
): Promise<HelperProjectRegistration> {
  assertSafeRuntimeBoundary(root);
  let initialPaths = projectPaths(root);
  let initialDeployment = readDeployment(root);
  let reconciledFiles: string[] = [];
  if (initialDeployment
    && !sameProjectCheckoutIdentity(initialDeployment.identity, initialPaths.identity)) {
    reconciledFiles = await reconcileMovedProjectIdentity(root);
    initialPaths = projectPaths(root);
    initialDeployment = readDeployment(root);
  }
  if (initialDeployment) {
    assertDeploymentIdentity(root, initialDeployment);
    assertDeploymentRegistryPair(root, initialDeployment);
    if (!fs.existsSync(initialPaths.config)
      && legacyDeploymentHasValidProjectConfig(root, initialDeployment)) {
      return withSetupTransaction(root, "setup", transaction => {
        const paths = projectPaths(root);
        const deployment = readDeployment(root);
        if (!deployment) {
          throw new HelperProjectError(
            "HELPER_PROJECT_CONFIG_INVALID",
            "The legacy deployment disappeared while its project authority was being projected.",
          );
        }
        assertDeploymentIdentity(root, deployment);
        const localFilesChanged: string[] = [...reconciledFiles];
        assertDeploymentRegistryPair(root, deployment);
        if (!fs.existsSync(paths.config)) {
          if (!legacyDeploymentHasValidProjectConfig(root, deployment)) {
            throw new HelperProjectError(
              "HELPER_PROJECT_CONFIG_INVALID",
              "The legacy project configuration disappeared while its authority was being projected.",
            );
          }
          const marker = projectRuntimeConfigSource();
          transaction.capture([paths.config]);
          transaction.prepareExpected(paths.config, jsonHash(marker));
          atomicWriteJson(paths.config, marker);
          transaction.markApplied([paths.config]);
          localFilesChanged.push(paths.config);
        }
        const readiness = inspectProjectReadiness(root);
        return {
          action: readiness.state === "ready" ? "preserved" as const : "attention" as const,
          projectId: paths.identity.id,
          projectRoot: paths.identity.root,
          configPath: paths.config,
          deploymentPath: paths.deployment,
          registryPath: paths.registry,
          workflowStatePath: paths.workflowState,
          scopePath: paths.scope,
          deployment,
          readiness,
          localFilesChanged,
          projectFilesChanged: [] as [],
        };
      });
    }
    const readiness = inspectProjectReadiness(root);
    return {
      action: readiness.state === "ready" ? "preserved" : "attention",
      projectId: initialPaths.identity.id,
      projectRoot: initialPaths.identity.root,
      configPath: initialPaths.config,
      deploymentPath: initialPaths.deployment,
      registryPath: initialPaths.registry,
      workflowStatePath: initialPaths.workflowState,
      scopePath: initialPaths.scope,
      deployment: initialDeployment,
      readiness,
      localFilesChanged: reconciledFiles,
      projectFilesChanged: [],
    };
  }

  assertNoOrphanRegistryRecord(root, initialPaths);
  return withSetupTransaction(root, "setup", transaction => {
    const paths = projectPaths(root);
    const concurrentDeployment = readDeployment(root);
    if (concurrentDeployment) {
      assertDeploymentIdentity(root, concurrentDeployment);
      const readiness = inspectProjectReadiness(root);
      assertDeploymentRegistryPair(root, concurrentDeployment);
      return {
        action: readiness.state === "ready" ? "preserved" as const : "attention" as const,
        projectId: paths.identity.id,
        projectRoot: paths.identity.root,
        configPath: paths.config,
        deploymentPath: paths.deployment,
        registryPath: paths.registry,
        workflowStatePath: paths.workflowState,
        scopePath: paths.scope,
        deployment: concurrentDeployment,
        readiness,
        localFilesChanged: [],
        projectFilesChanged: [] as [],
      };
    }

    assertNoOrphanRegistryRecord(root, paths);
    const configExisted = fs.existsSync(paths.config);
    const config = completeExternalConfig(root);
    transaction.capture([paths.config, paths.deployment, paths.registry]);
    const localFilesChanged: string[] = [];
    if (!configExisted) {
      transaction.prepareExpected(paths.config, jsonHash(config));
      atomicWriteJson(paths.config, config);
      transaction.markApplied([paths.config]);
      localFilesChanged.push(paths.config);
    }

    const deployment = writeDeployment(
      root,
      {
        setupVersion: SETUP_VERSION,
        mode: "shared",
        clients,
        projectFiles: [],
        tools: {},
        artifacts: {},
      },
      (resource, value) => transaction.prepareExpected(
        resource === "deployment" ? paths.deployment : paths.registry,
        jsonHash(value),
      ),
      resource => transaction.markApplied([resource === "deployment" ? paths.deployment : paths.registry]),
    );
    localFilesChanged.push(paths.deployment, paths.registry);
    const readiness = inspectProjectReadiness(root);
    return {
      action: readiness.state === "ready" ? "registered" as const : "attention" as const,
      projectId: paths.identity.id,
      projectRoot: paths.identity.root,
      configPath: paths.config,
      deploymentPath: paths.deployment,
      registryPath: paths.registry,
      workflowStatePath: paths.workflowState,
      scopePath: paths.scope,
      deployment,
      readiness,
      localFilesChanged,
      projectFilesChanged: [] as [],
    };
  });
}
