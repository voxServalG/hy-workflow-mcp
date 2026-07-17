// Verify that setup upgrade self-heals when only setup-owned sidecar fields
// (codex timeouts / sectionFingerprint) diverge while the MCP definition stays
// identical. This is the exact scenario seen upgrading from 0.1.x to 0.2.x where
// the existing ~/.codex/config.toml omits startup_timeout_sec/tool_timeout_sec.
import { clientSnapshotEquals } from "../../src/setup/clients/effective.js";
import type { ClientServerSnapshot } from "../../src/setup/types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const desiredDefinition = { command: "hy-workflow", args: [] as string[] };

// Simulates current inspect() of a real ~/.codex/config.toml that lacks timeout lines
const current: ClientServerSnapshot = {
  definition: desiredDefinition,
  ownedDefinition: desiredDefinition,
  source: "/home/vox/.codex/config.toml",
  scope: "user",
  enabled: true,
  state: "active",
  raw: {
    present: true,
    command: "hy-workflow",
    args: [],
    enabled: true,
    startup_timeout_sec: undefined,
    tool_timeout_sec: undefined,
    sectionFingerprint: "current-fingerprint-without-timeouts",
    configMode: 384,
  },
};

// Simulates the applied snapshot recorded in ownership manifest by a prior setup
const applied: ClientServerSnapshot = {
  definition: { command: "hy-workflow", args: [] },
  ownedDefinition: { command: "hy-workflow", args: [] },
  source: "/home/vox/.codex/config.toml",
  scope: "user",
  enabled: true,
  state: "active",
  raw: {
    present: true,
    command: "hy-workflow",
    args: [],
    enabled: true,
    startup_timeout_sec: 60,
    tool_timeout_sec: 300,
    sectionFingerprint: "old-fingerprint-with-timeouts",
    configMode: 384,
  },
};

// Install path must treat these as equal so setup can self-heal timeouts
assert(
  clientSnapshotEquals(current, applied) === true,
  "install path: definition-matching snapshots with diverging setup-owned sidecar fields must be treated as equal (setup will self-heal via setTimeouts)",
);

// Unset path must treat them as NOT equal (strict) so user edits are preserved
assert(
  clientSnapshotEquals(current, applied, { strictSidecars: true }) === false,
  "unset path: with strictSidecars, even sidecar divergence must block removal",
);

// If the command actually changes, both modes must detect drift
const tampered: ClientServerSnapshot = {
  ...current,
  definition: { command: "evil-binary", args: [] },
};
assert(clientSnapshotEquals(tampered, applied) === false, "real command change must always be drift");
assert(clientSnapshotEquals(tampered, applied, { strictSidecars: true }) === false, "real command change must be drift even in strict mode");

// Scope change must also always be drift
const scoped: ClientServerSnapshot = { ...current, scope: "project" };
assert(clientSnapshotEquals(scoped, applied) === false, "scope change must always be drift");

console.log("setup-effective-config: install-sidecar self-heal and unset-strict semantics pass");
