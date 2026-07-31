import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  readDeployment,
  readRegistry,
  type DeploymentManifest,
  type DeploymentRegistry,
  type LegacyDeploymentManifest,
  type RegistryRecord,
} from "../runtime/deployment.js";
import {
  atomicWriteJson,
  canonicalGitRemote,
  projectPaths,
  sameProjectCheckoutIdentity,
  type ProjectPaths,
} from "../runtime/user-paths.js";
import { setupFailpoint, withSetupTransaction } from "../setup/transaction.js";

export const IDENTITY_RECONCILIATION_REQUIRED = "HELPER_PROJECT_IDENTITY_RECONCILIATION_REQUIRED";

class HelperProjectIdentityError extends Error {
  readonly type = "helper" as const;
  readonly subtype = "project_registration" as const;
  readonly retryable = false;

  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HelperProjectIdentityError";
  }
}

function jsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, null, 2) + "\n").digest("hex");
}

function sameExactStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStoredIdentity(left: RegistryRecord, right: DeploymentManifest["identity"]): boolean {
  return left.id === right.id
    && left.root === right.root
    && left.gitCommonDir === right.gitCommonDir
    && left.remote === right.remote;
}

function registryDeploymentMismatches(
  record: RegistryRecord,
  deployment: DeploymentManifest | LegacyDeploymentManifest,
): string[] {
  return [
    ...(!sameStoredIdentity(record, deployment.identity) ? ["identity"] : []),
    ...(record.mode !== deployment.mode ? ["mode"] : []),
    ...(!sameExactStrings(record.clients, deployment.clients) ? ["clients"] : []),
    ...(record.updatedAt !== deployment.updatedAt ? ["updatedAt"] : []),
  ];
}

function registryPairError(projectId: string, mismatchedFields: string[]): HelperProjectIdentityError {
  return new HelperProjectIdentityError(
    "HELPER_DEPLOYMENT_REGISTRY_MISMATCH",
    "External project registration requires one exact registry/deployment pair.",
    { projectId, mismatchedFields },
  );
}

export function assertDeploymentRegistryPair(
  root: string,
  deployment: DeploymentManifest | LegacyDeploymentManifest,
): void {
  const registry = readRegistry(root);
  const record = registry.projects[deployment.identity.id];
  if (!record) throw registryPairError(deployment.identity.id, ["registryRecord"]);
  const mismatchedFields = registryDeploymentMismatches(record, deployment);
  if (mismatchedFields.length) {
    throw registryPairError(deployment.identity.id, mismatchedFields);
  }
}

function sameCheckoutRecord(
  record: RegistryRecord,
  identity: ProjectPaths["identity"],
): boolean {
  const canonical = (value: string): string => {
    const resolved = fs.realpathSync.native;
    try { return resolved(value); } catch { return value; }
  };
  return canonical(record.root) === canonical(identity.root)
    && canonical(record.gitCommonDir) === canonical(identity.gitCommonDir)
    && canonicalGitRemote(record.remote) === canonicalGitRemote(identity.remote);
}

export function assertNoOrphanRegistryRecord(
  root: string,
  paths: ProjectPaths = projectPaths(root),
): void {
  const registry = readRegistry(root);
  const records = Object.values(registry.projects).filter(record =>
    record.id === paths.identity.id || sameCheckoutRecord(record, paths.identity),
  );
  if (!records.length) return;
  throw registryPairError(
    paths.identity.id,
    [
      "deployment",
      ...records
        .filter(record => record.id !== paths.identity.id)
        .map(record => `legacyRegistryRecord:${record.id}`),
    ],
  );
}

export function assertDeploymentIdentity(
  root: string,
  deployment: DeploymentManifest | LegacyDeploymentManifest,
): void {
  const expected = projectPaths(root).identity;
  const actual = deployment.identity;
  if (!actual || !sameProjectCheckoutIdentity(actual, expected)) {
    throw new HelperProjectIdentityError(
      "HELPER_DEPLOYMENT_IDENTITY_MISMATCH",
      "Existing external deployment identity does not match the current Git project.",
      {
        projectId: expected.id,
        storedProjectId: actual?.id ?? null,
        storedRootExists: Boolean(actual?.root && fs.existsSync(actual.root)),
        remoteEquivalent: Boolean(actual
          && canonicalGitRemote(actual.remote) === canonicalGitRemote(expected.remote)),
      },
    );
  }
}

type MovedIdentityPlan = {
  paths: ProjectPaths;
  deployment: DeploymentManifest | LegacyDeploymentManifest;
  registry: DeploymentRegistry;
  record: RegistryRecord;
};

export function movedIdentityPlan(
  root: string,
  paths: ProjectPaths,
  deployment: DeploymentManifest | LegacyDeploymentManifest,
): MovedIdentityPlan {
  const actual = deployment.identity;
  const expected = paths.identity;
  const remoteEquivalent = Boolean(
    actual.remote
    && expected.remote
    && canonicalGitRemote(actual.remote) === canonicalGitRemote(expected.remote),
  );
  const eligible = actual.id === expected.id
    && !sameProjectCheckoutIdentity(actual, expected)
    && !fs.existsSync(actual.root)
    && remoteEquivalent;
  if (!eligible) {
    throw new HelperProjectIdentityError(
      "HELPER_DEPLOYMENT_IDENTITY_MISMATCH",
      "Existing external deployment identity cannot be reconciled safely with the current Git project.",
      {
        projectId: expected.id,
        storedProjectId: actual.id,
        storedRootExists: fs.existsSync(actual.root),
        remoteEquivalent,
      },
    );
  }

  const registry = readRegistry(root);
  const record = registry.projects[actual.id];
  if (!record) {
    throw new HelperProjectIdentityError(
      "HELPER_DEPLOYMENT_REGISTRY_MISMATCH",
      "Moved-checkout reconciliation requires one exact registry/deployment pair.",
      { projectId: actual.id, mismatchedFields: ["registryRecord"] },
    );
  }
  const mismatchedFields = registryDeploymentMismatches(record, deployment);
  if (mismatchedFields.length) {
    throw new HelperProjectIdentityError(
      "HELPER_DEPLOYMENT_REGISTRY_MISMATCH",
      "Moved-checkout reconciliation requires one exact registry/deployment pair.",
      { projectId: actual.id, mismatchedFields },
    );
  }
  return { paths, deployment, registry, record };
}

export async function reconcileMovedProjectIdentity(root: string): Promise<string[]> {
  return withSetupTransaction(root, "setup", transaction => {
    const paths = projectPaths(root);
    const deployment = readDeployment(root);
    if (!deployment) {
      throw new HelperProjectIdentityError(
        "HELPER_DEPLOYMENT_IDENTITY_MISMATCH",
        "The deployment disappeared before moved-checkout reconciliation.",
        { projectId: paths.identity.id },
      );
    }
    if (sameProjectCheckoutIdentity(deployment.identity, paths.identity)) return [];

    const plan = movedIdentityPlan(root, paths, deployment);
    const nextIdentity = { ...plan.paths.identity };
    const nextDeployment = { ...plan.deployment, identity: nextIdentity };
    const nextRecord = { ...plan.record, ...nextIdentity };
    const nextRegistry: DeploymentRegistry = {
      ...plan.registry,
      projects: {
        ...plan.registry.projects,
        [nextIdentity.id]: nextRecord,
      },
    };

    transaction.capture([plan.paths.deployment, plan.paths.registry]);
    transaction.prepareExpected(plan.paths.deployment, jsonHash(nextDeployment));
    atomicWriteJson(plan.paths.deployment, nextDeployment);
    transaction.markApplied([plan.paths.deployment]);

    setupFailpoint("registry");
    transaction.prepareExpected(plan.paths.registry, jsonHash(nextRegistry));
    atomicWriteJson(plan.paths.registry, nextRegistry);
    transaction.markApplied([plan.paths.registry]);
    return [plan.paths.deployment, plan.paths.registry];
  });
}
