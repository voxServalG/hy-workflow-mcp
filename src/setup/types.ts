import type { ClientName, DeploymentMode } from "../runtime/deployment.js";
import type { StructuredError } from "../errs/structured.js";
import type { ToolRecovery } from "../output/envelope.js";

export type SetupAction = "setup" | "unset";
export type SetupLanguage = "zh" | "en";
export type ServerName = "hy-workflow" | "docs-gardener";

export type McpDefinition = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type ClientConfigScope = "user" | "project" | "unknown";
export type ClientEffectiveState = "absent" | "active" | "disabled" | "shadowed" | "unreadable";

export type ClientConfigSource = {
  scope: ClientConfigScope;
  source: string;
  definition: McpDefinition | null;
  enabled: boolean | null;
};

export type ClientDetection = {
  name: ClientName;
  installed: boolean;
  executable: string | null;
  version: string | null;
  configured: ServerName[];
  error?: string;
};

export type ClientServerSnapshot = {
  definition: McpDefinition | null;
  raw?: unknown;
  source?: string;
  scope?: ClientConfigScope;
  enabled?: boolean | null;
  state?: ClientEffectiveState;
  sources?: ClientConfigSource[];
  ownedDefinition?: McpDefinition | null;
};

export type ClientAdapter = {
  name: ClientName;
  detect(): ClientDetection;
  inspect(server: ServerName): ClientServerSnapshot;
  /** expectedPrevious is the locked effective snapshot; mutation must fail before writing if it changed. */
  install(server: ServerName, definition: McpDefinition, expectedPrevious?: ClientServerSnapshot): ClientServerSnapshot;
  /** expectedCurrent is the snapshot that must still be effective immediately before removal. */
  remove(server: ServerName, expected: McpDefinition, previous?: ClientServerSnapshot | null, expectedCurrent?: ClientServerSnapshot): void;
};

export type SetupOptions = {
  action: SetupAction;
  mode: "shared";
  clients: ClientName[];
  language: SetupLanguage;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  removeGlobal: boolean;
  /**
   * Independent, explicit intent to replace occupied project integration
   * targets. Without this flag, artifact review inputs are inert and setup
   * treats unowned project files as metadata-only legacy surface.
   */
  syncProjectArtifacts?: boolean;
  acceptArtifactChanges?: boolean;
  /** Exact artifact diff hashes shown to and accepted by the user. */
  reviewedArtifactChanges?: Array<Pick<ArtifactChange, "file" | "beforeHash" | "afterHash">>;
  acceptCiCommands?: boolean;
  ciCommands?: string[];
  projectId?: string;
  /**
   * When set, setup will force-reinstall the owned user-scope MCP definition for these
   * clients even when an inspect() returns unreadable/shadowed/no-longer-matches. Only
   * user-scope entries are removed and rewritten; project-scope files are never touched.
   */
  forceClientOverwrite?: ClientName[];
  /**
   * Deprecated compatibility input. Historical project injections are inert;
   * setup never scans, copies, moves, deletes, or interprets them.
   */
  migrateLegacyClients?: boolean;
};

export type SetupClientStatus = "configured" | "replaced" | "removed" | "unchanged" | "shadowed" | "skipped" | "recovery_required";

export type ToolEvidence = {
  command: string;
  executable: string;
  version: string;
  catalogHash?: string;
};

export type ArtifactEvidence = {
  sha256: string;
  size: number;
};

export type ArtifactChange = {
  file: string;
  changeKind: "create" | "managed_update" | "drift" | "unmanaged_existing";
  beforeHash: string | null;
  afterHash: string;
  diff: string;
  requiresAcceptance: boolean;
};

export type SetupCliPhase = "setup";
export type SetupCliStage = "setup.apply" | "setup.unset";
export type SetupCliStatus = "completed" | "failed";

export type SetupCliNextAction = {
  tool: string | null;
  arguments?: Record<string, unknown>;
  phase: SetupCliPhase;
  stage: SetupCliStage;
  automatic: boolean;
};

export type SetupCliControl = {
  automatic: boolean;
  stop: boolean;
  reason: "completed" | "repair_required" | "wait_required";
};

export type SetupCliUserAction = {
  kind: "review_failure" | "wait";
  instruction: string;
};

export type SetupContract = {
  phase: SetupCliPhase;
  action: SetupAction;
  stage: SetupCliStage;
  status: SetupCliStatus;
  nextAction: SetupCliNextAction;
  control: SetupCliControl;
  userAction: SetupCliUserAction | null;
  recovery?: ToolRecovery;
};

export type SetupResult = SetupContract & {
  ok: true;
  mode: DeploymentMode;
  projectId: string;
  projectRoot: string;
  clients: Array<{ name: ClientName; status: SetupClientStatus; detail?: string; source?: string; scope?: ClientConfigScope }>;
  projectFilesChanged: string[];
  localFilesChanged: string[];
  remainingProjects?: number;
  dryRun: boolean;
  message: string;
  removed?: boolean;
  remainingOwnedClients?: ClientName[];
  transactionId?: string;
  tools?: Partial<Record<ServerName, ToolEvidence>>;
  artifactChanges?: ArtifactChange[];
  ciCandidates?: string[];
  ciConfirmationRequired?: boolean;
  /** How setup treated the two repository integration targets. */
  projectFileDisposition?: "fresh" | "managed" | "explicit-sync" | "external-only" | "legacy-inert";
  /** Configuration authority established or preserved by this setup result. */
  configAuthority?: "project" | "external" | "preserved";
};

export type SetupFailureResult = SetupContract & {
  ok: false;
  error: StructuredError;
};

export type SetupErrorSubtype =
  | "preflight"
  | "client_missing"
  | "client_config"
  | "client_shadowed"
  | "binary_missing"
  | "handshake"
  | "lock_busy"
  | "registry"
  | "transaction"
  | "postcondition"
  | "artifact_drift"
  | "identity"
  | "ownership"
  | "unset";

export class SetupFailure extends Error {
  readonly type = "setup" as const;
  readonly retryable: boolean;

  constructor(
    readonly subtype: SetupErrorSubtype,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly detail?: unknown,
    retryable = false,
  ) {
    super(message);
    this.name = "SetupFailure";
    this.retryable = retryable;
  }
}

export const MCP_DEFINITIONS: Record<ServerName, McpDefinition> = {
  "hy-workflow": { command: "hy-workflow", args: [] },
  "docs-gardener": { command: "docs-gardener", args: ["mcp"] },
};
