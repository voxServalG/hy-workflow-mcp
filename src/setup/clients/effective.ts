import { definitionEquals } from "./index.js";
import { SetupFailure, type ClientServerSnapshot, type McpDefinition, type ServerName } from "../types.js";

export function effectiveState(snapshot: ClientServerSnapshot): NonNullable<ClientServerSnapshot["state"]> {
  if (snapshot.state) return snapshot.state;
  if (snapshot.raw && !snapshot.definition) return "unreadable";
  if (snapshot.enabled === false) return "disabled";
  return snapshot.definition ? "active" : "absent";
}

function sourceEvidence(snapshot: ClientServerSnapshot): unknown {
  return (snapshot.sources ?? []).map(source => ({
    scope: source.scope,
    source: source.source,
    definition: source.definition,
    enabled: source.enabled,
  }));
}

export function clientSnapshotEquals(left: ClientServerSnapshot, right: ClientServerSnapshot, options: { strictSidecars?: boolean } = {}): boolean {
  if (effectiveState(left) !== effectiveState(right)) return false;
  if (left.definition ? !right.definition || !definitionEquals(left.definition, right.definition) : Boolean(right.definition)) return false;
  if (left.ownedDefinition ? !right.ownedDefinition || !definitionEquals(left.ownedDefinition, right.ownedDefinition) : Boolean(right.ownedDefinition)) return false;
  if ((left.source ?? null) !== (right.source ?? null) || (left.scope ?? null) !== (right.scope ?? null) || (left.enabled ?? null) !== (right.enabled ?? null)) return false;
  if (JSON.stringify(sourceEvidence(left)) !== JSON.stringify(sourceEvidence(right))) return false;
  if (options.strictSidecars) {
    // For unset/remove, treat raw sidecar fields strictly so a user edit to the
    // owned section/entry (comments, formatting, extra keys) is not silently
    // deleted. Install/upgrade paths call with strictSidecars=false so setup
    // can self-heal its own managed sidecars (timeouts, fingerprints).
    const leftRaw = left.raw as any;
    const rightRaw = right.raw as any;
    for (const key of ["startup_timeout_sec", "tool_timeout_sec", "sectionFingerprint", "entryFingerprint", "configMode"]) {
      if ((leftRaw?.[key] ?? null) !== (rightRaw?.[key] ?? null)) return false;
    }
  }
  return true;
}

export function assertClientSnapshotUnchanged(client: string, server: ServerName, expected: ClientServerSnapshot, current: ClientServerSnapshot): void {
  if (clientSnapshotEquals(expected, current)) return;
  throw new SetupFailure(
    "client_config",
    "SETUP_CLIENT_CONFIG_UNSAFE",
    `${client} ${server} changed after locked preflight; refusing to overwrite it.`,
    "Review the effective client configuration, then rerun setup. The concurrent definition was preserved.",
    { client, server, expected, current },
    true,
  );
}

export function assertSafeEffectiveConfig(
  client: string,
  server: ServerName,
  snapshot: ClientServerSnapshot,
  desired: McpDefinition,
): void {
  const state = effectiveState(snapshot);
  if (state === "unreadable") {
    throw new SetupFailure(
      "client_config",
      "SETUP_CLIENT_CONFIG_UNSAFE",
      `${client} ${server} exists but could not be inspected safely.`,
      `Run hy-workflow doctor --json and repair the reported ${client} configuration source before retrying setup.`,
      { client, server, source: snapshot.source, raw: snapshot.raw },
    );
  }
  if (state === "disabled") {
    throw new SetupFailure(
      "client_config",
      "SETUP_CLIENT_CONFIG_UNSAFE",
      `${client} ${server} is disabled in ${snapshot.source ?? "the effective client configuration"}.`,
      "Enable or remove the existing definition explicitly, then rerun setup.",
      { client, server, source: snapshot.source, state },
    );
  }
  if (state === "shadowed" || (snapshot.scope === "project" && !definitionEquals(snapshot.definition, desired))) {
    throw new SetupFailure(
      "client_shadowed",
      "SETUP_EFFECTIVE_CONFIG_SHADOWED",
      `${client} ${server} is shadowed by project configuration${snapshot.source ? ` at ${snapshot.source}` : ""}.`,
      "Review and remove or migrate the project-owned legacy definition yourself; setup will not delete tracked project configuration.",
      { client, server, source: snapshot.source, scope: snapshot.scope, sources: snapshot.sources },
    );
  }
}

export function assertDesiredEffectiveConfig(
  client: string,
  server: ServerName,
  snapshot: ClientServerSnapshot,
  desired: McpDefinition,
): void {
  assertSafeEffectiveConfig(client, server, snapshot, desired);
  if (!definitionEquals(snapshot.definition, desired)) {
    throw new SetupFailure(
      "postcondition",
      "SETUP_POSTCONDITION_FAILED",
      `${client} ${server} is not effective after setup.`,
      "Run hy-workflow doctor --json. The setup journal has been kept for recovery.",
      { client, server, effective: snapshot.definition, desired, source: snapshot.source },
    );
  }
}
