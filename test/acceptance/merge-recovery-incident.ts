import { chdir, cwd } from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createGitGhHarness } from "../helpers/git-gh-harness.js";
import type { AcceptanceWorkspace } from "./harness.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function overlayEnvironment(environment: NodeJS.ProcessEnv): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export async function runMergeRecoveryIncident(
  workspace: AcceptanceWorkspace,
  fixture: { id: string; incident: string },
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const packageRoot = workspace.env.HY_ACCEPTANCE_PACKAGE_ROOT;
  assert(packageRoot, "packed baseline package root is unavailable");
  const restoreEnvironment = overlayEnvironment(workspace.env);
  const originalCwd = cwd();
  let harness: ReturnType<typeof createGitGhHarness> | null = null;

  try {
    harness = createGitGhHarness(fixture.id, workspace.repos);
    chdir(harness.root);
    const [{ handleMerge }, { readState, writeState }] = await Promise.all([
      import(pathToFileURL(join(packageRoot, "dist", "tools", "merge.js")).href),
      import(pathToFileURL(join(packageRoot, "dist", "state.js")).href),
    ]);
    const implementationDigest = `acceptance-${harness.verifiedOid}`;
    writeState({
      version: "1",
      phase: "merge",
      branch: harness.sourceBranch,
      prNumber: harness.prNumber,
      plan: {
        task: "recover an unknown remote merge outcome from exact offline Git evidence",
        scope: { changes: ["src/app.ts"], new_files: [], delete: [] },
        boundary: {
          dependency_dag: "verified commit -> PR merge -> remote base ancestry -> local downstream synchronization",
          entry_points: ["npm run test:acceptance:baseline"],
          no_new_external: true,
        },
        verify: {
          platform: { python_version: "N/A", setup: [] },
          smoke: [{ command: "node --version", expected_exit: 0, description: "runtime" }],
          tests: [{ command: "npm run test:acceptance:baseline", expected_exit: 0, description: "incident oracle" }],
        },
        risks: [
          "Scenario: GitHub accepts merge before the client times out and local checkout then fails; impact: retry can repeat a mutation or reject MERGED as identity drift; mitigation: fresh exact Git ancestry and idempotent local recovery.",
        ],
        discussion: "Use Git only to prove the verified commit is already in the configured remote base. Directly pushing the base branch was rejected.",
        branch: harness.sourceBranch,
        verify_hash: null,
        pr_number: harness.prNumber,
      },
      approval: {
        time: new Date().toISOString(),
        note: "acceptance",
        commitRecovery: {
          version: 1,
          commitOid: harness.verifiedOid,
          implementationDigest,
          branch: harness.sourceBranch,
          baseBranch: harness.baseBranch,
          repository: harness.repository,
        },
      },
      verifiedImplementationDigest: implementationDigest,
    });

    harness.setGhMergeExit("remote-success-error");
    harness.setGhViewMode("unavailable-after-merge");
    harness.failGitOnce("checkout", harness.baseBranch);
    const first = await handleMerge();
    assert(first.ok === false && first.phase === "merge" && first.next === "merge", `first installed-package merge should stop in merge after local checkout failure: ${JSON.stringify(first)}`);
    assert(first.error?.code === "POST_MERGE_SYNC_INCOMPLETE", `installed package must distinguish confirmed integration from incomplete local sync: ${JSON.stringify(first)}`);
    assert(readState().phase === "merge", "installed package must persist merge phase after interrupted local recovery");
    assert(harness.remoteContains(harness.baseBranch, harness.verifiedOid), "unknown-outcome oracle must prove the remote accepted the verified commit");
    assert(harness.ghCalls("pr merge ").length === 1, "unknown-outcome oracle must perform one remote merge");

    harness.setGhCapability("unavailable");
    const fetchesBeforeRetry = harness.gitCalls("fetch ").length;
    const retry = await handleMerge();
    assert(retry.ok === true && retry.next === "done", `installed package must recover through fresh Git ancestry with gh unavailable: ${JSON.stringify(retry)}`);
    assert(retry.data?.evidence === "git", `installed package must report actual Git recovery evidence: ${JSON.stringify(retry.data)}`);
    assert(retry.data?.outcome === "already_integrated", `installed package must report the reconciled already_integrated outcome: ${JSON.stringify(retry.data)}`);
    assert(retry.data?.executor?.executor === "git" && retry.data.executor.available === true, `installed package must expose the actual Git recovery executor: ${JSON.stringify(retry.data?.executor)}`);
    assert(readState().phase === "done", "installed package retry must persist done");
    assert(harness.ghCalls("pr merge ").length === 1, "installed package retry must not repeat the remote merge");
    const retryFetches = harness.gitCalls("fetch ").slice(fetchesBeforeRetry);
    assert(retryFetches.length === 1 && retryFetches[0].includes(harness.baseBranch), `confirmed receipt retry must refresh configured-base ancestry exactly once: ${JSON.stringify(retryFetches)}`);
    assert(harness.remoteOid(harness.sourceBranch) === null, "installed package retry must not recreate the deleted source branch");
    assert(!harness.gitCalls("push ").some(call => call.includes(harness.sourceBranch)), "installed package retry must exclude the merged source branch from downstream pushes");
    assert(!harness.gitCalls("push ").some(call => call.split(/\s+/).some(token => token === harness.baseBranch || token.endsWith(`refs/heads/${harness.baseBranch}`))), "read-only Git fallback must never push the configured base branch");

    return {
      name: fixture.id,
      incident: fixture.incident,
      offline: true,
      packedTarball: true,
      oracle: {
        remoteMergeCalls: 1,
        firstPhase: "merge",
        retryPhase: "done",
        retryEvidence: retry.data.evidence,
        retryOutcome: retry.data.outcome,
        sourceBranchRecreated: false,
      },
      durationMs: Date.now() - started,
    };
  } finally {
    chdir(originalCwd);
    harness?.cleanup();
    restoreEnvironment();
  }
}
