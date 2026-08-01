export const HELPER_SKILL_NAMES = [
  "hy-init",
  "hy-verify",
  "hy-capture",
] as const;

/** Exact v0.5 catalog. It exists only for ownership-safe migration and recovery. */
export const LEGACY_HELPER_SKILL_NAMES = [
  "hy-init",
  "hy-status",
  "hy-read-docs",
  "hy-plan",
  "hy-approve",
  "hy-branch",
  "hy-edit",
  "hy-sync-docs",
  "hy-verify",
  "hy-commit",
  "hy-merge",
  "hy-reset",
] as const;

/** Every fixed Skill name that a valid current or legacy journal may own. */
export const MANAGED_HELPER_SKILL_NAMES = [
  ...LEGACY_HELPER_SKILL_NAMES,
  "hy-capture",
] as const;

export type HelperSkillName = typeof HELPER_SKILL_NAMES[number];
export type LegacyHelperSkillName = typeof LEGACY_HELPER_SKILL_NAMES[number];
export type ManagedHelperSkillName = typeof MANAGED_HELPER_SKILL_NAMES[number];
export type HelperSkillAgent = "codex" | "claude" | "opencode";
export type HelperSkillProjectionMode = "symlink" | "copy";
export type HelperSkillProjectionPreference = HelperSkillProjectionMode | "auto";

export type HelperSkillTarget = {
  agent: HelperSkillAgent;
  skillsDir: string;
};

export type DetectedHelperSkillTarget = HelperSkillTarget & {
  detected: boolean;
  evidence: string[];
};

export type HelperSkillPaths = {
  dataRoot: string;
  stateRoot: string;
  ssotRoot: string;
  manifestPath: string;
  lockPath: string;
};

export type HelperSkillProjectionRecord = {
  agent: HelperSkillAgent;
  path: string;
  mode: HelperSkillProjectionMode;
  contentHash: string;
  intentionalDeletion: boolean;
};

export type HelperSkillOwnershipRecord = {
  name: string;
  canonicalPath: string;
  sourceHash: string;
  contentHash: string;
  intentionalDeletion: boolean;
  retired: boolean;
  projections: HelperSkillProjectionRecord[];
};

export type HelperSkillTargetRecord = {
  agent: HelperSkillAgent;
  skillsDir: string;
  resolvedSkillsDir: string;
  preference: HelperSkillProjectionPreference;
};

export type HelperSkillOwnershipManifest = {
  schemaVersion: "1" | "2";
  package: {
    name: string;
    version: string;
    bundleHash: string;
  };
  canonicalRoot: string;
  targets: HelperSkillTargetRecord[];
  skills: HelperSkillOwnershipRecord[];
  installedAt: string;
  updatedAt: string;
};

export type HelperSkillFinding = {
  code: string;
  path: string;
  message: string;
};

export type HelperSkillStatus = {
  state: "absent" | "healthy" | "drifted" | "unmanaged";
  paths: HelperSkillPaths;
  manifest: HelperSkillOwnershipManifest | null;
  findings: HelperSkillFinding[];
  bundleHash: string | null;
};

export type HelperSkillOperationResult = {
  action: "installed" | "updated" | "removed" | "unchanged";
  manifest: HelperSkillOwnershipManifest | null;
  changes: string[];
};

export type HelperSkillFaultHooks = {
  createSymlink?: (target: string, destination: string) => void;
  beforeManifestWrite?: () => void;
  afterMutation?: (destination: string, mutationIndex: number) => void;
};

export type EnvironmentOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
};

export type PathOptions = EnvironmentOptions & {
  paths?: HelperSkillPaths;
};

export type BundleOptions = PathOptions & {
  bundleRoot?: string;
  packageName?: string;
  packageVersion?: string;
  beforeMutation?: (destination: string, mutationIndex: number) => void;
  hooks?: HelperSkillFaultHooks;
};

export type InstallHelperSkillsOptions = BundleOptions & {
  targets?: HelperSkillTarget[];
  mode?: HelperSkillProjectionPreference;
};

export type UpdateHelperSkillsOptions = BundleOptions & {
  repair?: boolean;
};

export type RemoveHelperSkillsOptions = PathOptions & {
  hooks?: HelperSkillFaultHooks;
};

export type SkillBundleEntry = {
  name: HelperSkillName;
  sourcePath: string;
  hash: string;
};

export type HelperSkillBundle = {
  root: string;
  hash: string;
  skills: SkillBundleEntry[];
};

export type ResourceState = "present" | "missing";

export type InspectedOwnership = {
  canonical: Map<string, ResourceState>;
  projections: Map<string, ResourceState>;
};

export const HELPER_SKILL_AGENTS: readonly HelperSkillAgent[] = ["codex", "claude", "opencode"];

export class HelperSkillError extends Error {
  readonly code: string;
  readonly detail?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: string, message: string, detail?: Record<string, unknown>, retryable = code === "HELPER_SKILL_BUSY") {
    super(message);
    this.name = "HelperSkillError";
    this.code = code;
    this.detail = detail;
    this.retryable = retryable;
  }
}

export function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new HelperSkillError(code, message, detail);
}
