import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { buildImplementationManifest } from "../../src/checks.js";
import { checkCi, commitScope, createPr, mergePr } from "../../src/git.js";
import { computeImplementationDigest, computeImplementationManifestHash, computeVerifyHash, readState, writeState, type PlanDoc, type WorkflowState } from "../../src/state.js";
import { handleCommit } from "../../src/tools/commit.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), "hy-commit-retry-"));
const runtimeHome = mkdtempSync(join(tmpdir(), "hy-commit-retry-runtime-"));
const originalPath = process.env.PATH ?? "";
const originalCwd = cwd();
const originalGhRepo = process.env.GH_REPO;
const originalGhHost = process.env.GH_HOST;
process.env.HY_WORKFLOW_CONFIG_HOME = join(runtimeHome, "config");
process.env.HY_WORKFLOW_STATE_HOME = join(runtimeHome, "state");
process.env.HY_WORKFLOW_CACHE_HOME = join(runtimeHome, "cache");

try {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);

  for (const file of ["A.js", "B.js", "doc-1.md", "doc-2.md"]) writeFileSync(join(root, file), `${file}\n`, "utf-8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);

  const scope: PlanDoc["scope"] = {
    changes: ["doc-1.md", "doc-2.md"],
    new_files: [],
    delete: ["A.js", "B.js"],
  };

  unlinkSync(join(root, "A.js"));
  unlinkSync(join(root, "B.js"));
  writeFileSync(join(root, "doc-1.md"), "first fix\n", "utf-8");
  const first = commitScope(root, scope, "first", "delete old files");
  assert(first.ok, `first scoped commit should succeed: ${JSON.stringify(first)}`);
  assert(first.stagedPaths?.includes("A.js") && first.stagedPaths?.includes("B.js"), "first commit should stage current deletions");

  writeFileSync(join(root, "doc-2.md"), "ci follow-up\n", "utf-8");
  const second = commitScope(root, scope, "second", "ci fix");
  assert(second.ok, `second scoped commit should skip already committed deletions: ${JSON.stringify(second)}`);
  assert(JSON.stringify(second.stagedPaths) === JSON.stringify(["doc-2.md"]), `second commit should stage only the live diff: ${JSON.stringify(second.stagedPaths)}`);
  assert(git(root, ["status", "--porcelain"]) === "", "worktree should be clean after the second commit");
  assert(git(root, ["rev-list", "--count", "HEAD"]) === "3", "both scoped commits should be recorded");
  git(root, ["remote", "add", "origin", "https://github.com/o/r.git"]);

  const bin = join(root, "bin");
  const log = join(root, "gh.log");
  const gitLog = join(root, "git.log");
  const raceMarker = join(root, "race-created");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
set -u
printf '%s|GH_REPO=%s|GH_HOST=%s\\n' "$*" "\${GH_REPO-unset}" "\${GH_HOST-unset}" >> "$HY_TEST_GH_LOG"
if [ "\${1:-}" = "--version" ]; then printf 'gh version test\\n'; exit 0; fi
if [ "\${1:-}" = "auth" ] && [ "\${2:-}" = "status" ]; then exit 0; fi
emit_pr() {
  number="$1"
  oid="$2"
  base="dev"
  if [ "$HY_TEST_PR_SCENARIO" = "workflow-retry" ]; then base="main"; fi
  printf '[{"number":%s,"url":"https://github.com/o/r/pull/%s","state":"OPEN","baseRefName":"%s","headRefName":"feat/retry","headRefOid":"%s","isCrossRepository":false}]' "$number" "$number" "$base" "$oid"
}
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "list" ]; then
  oid="$(git rev-parse HEAD)"
  case "$HY_TEST_PR_SCENARIO" in
    existing) emit_pr 178 "$oid" ;;
    none) if [ -f "$HY_TEST_RACE_MARKER" ]; then emit_pr 179 "$oid"; else printf '[]'; fi ;;
    multiple) printf '[{"number":178,"url":"https://github.com/o/r/pull/178","state":"OPEN","baseRefName":"dev","headRefName":"feat/retry","headRefOid":"%s","isCrossRepository":false},{"number":179,"url":"https://github.com/o/r/pull/179","state":"OPEN","baseRefName":"dev","headRefName":"feat/retry","headRefOid":"%s","isCrossRepository":false}]' "$oid" "$oid" ;;
    lookup-error) printf 'lookup failed\\n' >&2; exit 1 ;;
    create-error-recovery)
      if [ -f "$HY_TEST_RACE_MARKER" ]; then emit_pr 180 "$oid"; else printf '[]'; fi ;;
    stale-oid) emit_pr 181 0000000000000000000000000000000000000000 ;;
    unconfirmed) printf '[]' ;;
    confirmation-mismatch) if [ -f "$HY_TEST_RACE_MARKER" ]; then emit_pr 182 "$oid"; else printf '[]'; fi ;;
    workflow-retry)
      if [ ! -f "$HY_TEST_RACE_MARKER" ]; then
        printf '[]'
      elif [ ! -f "$HY_TEST_RACE_MARKER.post-failed" ]; then
        : > "$HY_TEST_RACE_MARKER.post-failed"
        printf 'temporary post-create lookup failure\\n' >&2
        exit 1
      else
        emit_pr 190 "$oid"
      fi ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "create" ]; then
  case "$HY_TEST_PR_SCENARIO" in
    none) : > "$HY_TEST_RACE_MARKER"; printf 'https://github.com/o/r/pull/179\\n'; exit 0 ;;
    create-error-recovery) : > "$HY_TEST_RACE_MARKER"; printf 'remote accepted request before connection failed\\n' >&2; exit 1 ;;
    unconfirmed) printf 'https://github.com/o/r/pull/183\\n'; exit 0 ;;
    confirmation-mismatch) : > "$HY_TEST_RACE_MARKER"; printf 'https://github.com/o/r/pull/181\\n'; exit 0 ;;
    workflow-retry) : > "$HY_TEST_RACE_MARKER"; printf 'https://github.com/o/r/pull/190\\n'; exit 0 ;;
  esac
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "view" ]; then
  oid="$(git rev-parse HEAD)"
  if [ "$HY_TEST_PR_SCENARIO" = "ci-stale" ]; then oid="0000000000000000000000000000000000000000"; fi
  printf '{"state":"OPEN","baseRefName":"main","headRefName":"feat/retry","headRefOid":"%s","isCrossRepository":false,"statusCheckRollup":[{"name":"Verify","conclusion":"SUCCESS"}]}' "$oid"
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "merge" ]; then exit 0; fi
exit 3
`, "utf-8");
  const realGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
writeFileSync(join(bin, "git"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HY_TEST_GIT_LOG"
if [ -n "\${HY_TEST_ORIGIN_OVERRIDE:-}" ] && { [ "$*" = "remote get-url --all origin" ] || [ "$*" = "remote get-url --push --all origin" ]; }; then
  printf '%s\\n' "$HY_TEST_ORIGIN_OVERRIDE"
  exit 0
fi
if [ "\${1:-}" = "push" ] && [ "\${2:-}" = "-u" ] && [ "\${3:-}" = "origin" ] && [ -n "\${HY_TEST_PUSH_TARGET:-}" ]; then
  exec "${realGit}" push -u "$HY_TEST_PUSH_TARGET" "$4"
fi
exec "${realGit}" "$@"
`, "utf-8");
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.HY_TEST_GH_LOG = log;
  process.env.HY_TEST_GIT_LOG = gitLog;
  process.env.HY_TEST_RACE_MARKER = raceMarker;
  process.env.GH_REPO = "evil/wrong";
  process.env.GH_HOST = "evil.example";
  function calls(): string[] { return readFileSync(log, "utf-8").trim().split("\n").filter(line => line.startsWith("pr ")); }
  function resetScenario(scenario: string): void {
    process.env.HY_TEST_PR_SCENARIO = scenario;
    writeFileSync(log, "", "utf-8");
    rmSync(raceMarker, { force: true });
    rmSync(`${raceMarker}.post-failed`, { force: true });
  }
  const expectedOid = git(root, ["rev-parse", "HEAD"]);

  resetScenario("existing");
  const existing = createPr(root, "title", "body", "dev", "feat/retry", expectedOid, "github.com/o/r");
  assert(existing.ok && existing.reused && existing.prNumber === 178, `one exact open PR should be reused: ${JSON.stringify(existing)}`);
  assert(calls().length === 1 && calls()[0].startsWith("pr list "), `reuse must not invoke pr create: ${JSON.stringify(calls())}`);

  resetScenario("none");
  const created = createPr(root, "title", "body", "dev", "feat/retry", expectedOid, "github.com/o/r");
  assert(created.ok && created.reused === false && created.prNumber === 179, `zero matches should create a PR: ${JSON.stringify(created)}`);
  assert(calls().length === 3 && calls()[1].startsWith("pr create ") && calls()[2].startsWith("pr list "), `creation must be confirmed by a second exact lookup: ${JSON.stringify(calls())}`);

  resetScenario("multiple");
  const multiple = createPr(root, "title", "body", "dev", "feat/retry", expectedOid, "github.com/o/r");
  assert(!multiple.ok && (multiple.error as any)?.code === "PR_LOOKUP_AMBIGUOUS", `multiple exact matches should fail closed: ${JSON.stringify(multiple)}`);
  assert(calls().length === 1, `ambiguous lookup must not create: ${JSON.stringify(calls())}`);

  resetScenario("lookup-error");
  const lookupError = createPr(root, "title", "body", "dev", "feat/retry", expectedOid, "github.com/o/r");
  assert(!lookupError.ok && (lookupError.error as any)?.code === "PR_LOOKUP_FAILED", `lookup errors should fail closed: ${JSON.stringify(lookupError)}`);
  assert(calls().length === 1, `failed lookup must not create: ${JSON.stringify(calls())}`);

  resetScenario("create-error-recovery");
  const recovered = createPr(root, "title", "body", "dev", "feat/retry", expectedOid, "github.com/o/r");
  assert(recovered.ok && recovered.reused && recovered.prNumber === 180, `create error should recover only through one exact open PR: ${JSON.stringify(recovered)}`);
  assert(calls().length === 3, `create recovery should perform one post-error lookup: ${JSON.stringify(calls())}`);

  resetScenario("stale-oid");
  const staleOid = createPr(root, "title", "body", "dev", "feat/retry", expectedOid, "github.com/o/r");
  assert(!staleOid.ok && (staleOid.error as any)?.code === "PR_HEAD_OID_MISMATCH" && calls().length === 1, `stale PR head must fail closed without create: ${JSON.stringify(staleOid)}`);

  resetScenario("unconfirmed");
  const unconfirmed = createPr(root, "title", "body", "dev", "feat/retry", expectedOid, "github.com/o/r");
  assert(!unconfirmed.ok && (unconfirmed.error as any)?.code === "PR_CREATE_UNCONFIRMED" && calls().length === 3, `successful create output must not bypass post-create confirmation: ${JSON.stringify(unconfirmed)}`);

  resetScenario("confirmation-mismatch");
  const mismatch = createPr(root, "title", "body", "dev", "feat/retry", expectedOid, "github.com/o/r");
  assert(!mismatch.ok && (mismatch.error as any)?.code === "PR_CREATE_CONFIRMATION_MISMATCH", `create output number must match the confirmed PR: ${JSON.stringify(mismatch)}`);
  assert(calls().every(line => line.includes("--repo github.com/o/r") && line.endsWith("GH_REPO=unset|GH_HOST=unset")), `every PR call must bind origin and ignore GH_REPO/GH_HOST: ${JSON.stringify(calls())}`);

  git(root, ["config", "remote.origin.pushurl", "https://github.com/evil/other.git"]);
  resetScenario("existing");
  const splitOrigin = createPr(root, "title", "body", "dev", "feat/retry", expectedOid, "github.com/o/r");
  assert(!splitOrigin.ok && (splitOrigin.error as any)?.code === "ORIGIN_REPOSITORY_MISMATCH", `fetch/push repository split must fail before PR lookup: ${JSON.stringify(splitOrigin)}`);
  assert(calls().length === 0, "origin repository mismatch must not query or create a PR");
  git(root, ["config", "--unset-all", "remote.origin.pushurl"]);

  const workflowRoot = join(root, "workflow");
  const bareRoot = join(root, "workflow-bare.git");
  mkdirSync(workflowRoot);
  git(workflowRoot, ["init", "-b", "main"]);
  git(workflowRoot, ["config", "user.email", "test@example.com"]);
  git(workflowRoot, ["config", "user.name", "Test"]);
  mkdirSync(join(workflowRoot, "src"));
  mkdirSync(join(workflowRoot, "docs"));
  writeFileSync(join(workflowRoot, "src", "app.ts"), "export const value = 1;\n", "utf-8");
  writeFileSync(join(workflowRoot, "docs", "index.md"), "# Docs\n", "utf-8");
  writeFileSync(join(workflowRoot, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"] },
    doclint: { maxLines: 200 },
    docsGardener: { catalogs: {} },
  }, null, 2) + "\n", "utf-8");
  git(workflowRoot, ["add", "."]);
  git(workflowRoot, ["commit", "-m", "initial"]);
  git(workflowRoot, ["remote", "add", "origin", "https://github.com/o/r.git"]);
  mkdirSync(bareRoot);
  git(bareRoot, ["init", "--bare"]);
  process.env.HY_TEST_PUSH_TARGET = bareRoot;
  git(workflowRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(workflowRoot, ["checkout", "-b", "feat/retry"]);
  writeFileSync(join(workflowRoot, "src", "app.ts"), "export const value = 2;\n", "utf-8");

  const plan: PlanDoc = {
    task: "recover an already committed verified snapshot after PR confirmation fails",
    scope: { changes: ["src/app.ts"], new_files: [], delete: [] },
    boundary: { dependency_dag: "hy_commit -> exact push -> exact PR", entry_points: ["npm run build", "npm test"], no_new_external: true },
    verify: {
      platform: { python_version: "N/A", setup: [] },
      smoke: [{ command: "npm run build", expected_exit: 0, description: "compile" }],
      tests: [{ command: "npm test", expected_exit: 0, description: "tests" }],
    },
    risks: ["Scenario: PR confirmation fails after push; impact: retry could create an empty commit or duplicate PR; mitigation: recover the verified HEAD and query by exact OID."],
    discussion: "Reuse the verified HEAD on retry. Creating an empty commit was rejected because it changes the reviewed object ID.",
    branch: "feat/retry",
    verify_hash: null,
    pr_number: null,
  };
  chdir(workflowRoot);
  const manifest = buildImplementationManifest(workflowRoot);
  const state: WorkflowState = {
    version: "1",
    phase: "commit",
    branch: "feat/retry",
    prNumber: null,
    plan,
    approval: { time: new Date().toISOString(), note: "approved" },
    verifyHash: null,
    implementationManifest: manifest,
    verifiedManifestHash: computeImplementationManifestHash(manifest),
    verifiedImplementationDigest: computeImplementationDigest(workflowRoot, manifest),
  };
  state.verifyHash = computeVerifyHash(state);
  writeState(state);
  resetScenario("workflow-retry");
  writeFileSync(gitLog, "", "utf-8");
  const commitCountBefore = git(workflowRoot, ["rev-list", "--count", "HEAD"]);
  const firstAttempt = await handleCommit({ title: "fix: retry safely", body: "exercise recovery" });
  assert(firstAttempt.next === "commit" && firstAttempt.error?.code === "PR_LOOKUP_FAILED", `first PR confirmation failure should leave commit recoverable: ${JSON.stringify(firstAttempt)}`);
  assert(firstAttempt.data?.commit?.action === "created", `first attempt should report the created commit: ${JSON.stringify(firstAttempt.data)}`);
  const committedHead = git(workflowRoot, ["rev-parse", "HEAD"]);
  assert(git(workflowRoot, ["status", "--porcelain"]) === "", "first failed PR confirmation should leave a clean worktree");
  assert(git(bareRoot, ["rev-parse", "refs/heads/feat/retry"]) === committedHead, "first attempt should already have pushed the exact verified commit");
  const firstFailureState = readState();
  const firstRecovery = (firstFailureState.approval as { commitRecovery?: any } | null)?.commitRecovery;
  assert(firstFailureState.phase === "commit", "PR confirmation failure must preserve commit phase");
  assert(firstRecovery?.commitOid === committedHead && firstRecovery?.repository === "github.com/o/r" && firstRecovery?.baseBranch === "main", "the exact commit/repository/base identity must be persisted before push or PR side effects");

  git(workflowRoot, ["reset", "--mixed", "HEAD^"]);
  process.env.HY_TEST_ORIGIN_OVERRIDE = "https://github.com/evil/other.git";
  const pushesBeforeOriginAttack = readFileSync(gitLog, "utf-8").split("\n").filter(line => line.startsWith("push ")).length;
  const originAttack = await handleCommit({ title: "fix: retry safely", body: "exercise recovery" });
  assert(originAttack.next === "commit" && originAttack.error?.code === "COMMIT_RECOVERY_IDENTITY_MISMATCH", `origin drift under the same verify hash must not create a replacement commit: ${JSON.stringify(originAttack)}`);
  assert(readFileSync(gitLog, "utf-8").split("\n").filter(line => line.startsWith("push ")).length === pushesBeforeOriginAttack, "origin-drift recovery mismatch must stop before push");
  delete process.env.HY_TEST_ORIGIN_OVERRIDE;
  git(workflowRoot, ["reset", "--hard", committedHead]);

  git(workflowRoot, ["reset", "--mixed", "HEAD^"]);
  const pushesBeforeResetAttack = readFileSync(gitLog, "utf-8").split("\n").filter(line => line.startsWith("push ")).length;
  const resetAttack = await handleCommit({ title: "fix: retry safely", body: "exercise recovery" });
  assert(resetAttack.next === "commit" && resetAttack.error?.code === "COMMIT_RECOVERY_WORKTREE_CHANGED", `a mixed reset must not turn recovery into a new commit: ${JSON.stringify(resetAttack)}`);
  assert(git(workflowRoot, ["rev-parse", "HEAD"]) !== committedHead, "mixed-reset attack should exercise a moved HEAD with dirty scoped content");
  assert(readFileSync(gitLog, "utf-8").split("\n").filter(line => line.startsWith("push ")).length === pushesBeforeResetAttack, "dirty recovery mismatch must stop before push");
  git(workflowRoot, ["reset", "--hard", committedHead]);

  const secondAttempt = await handleCommit({ title: "fix: retry safely", body: "exercise recovery" });
  assert(secondAttempt.next === "ci" && secondAttempt.reused === true && secondAttempt.prNumber === 190, `second attempt should reuse the exact PR and advance to ci: ${JSON.stringify(secondAttempt)}`);
  assert(secondAttempt.data?.commit?.action === "recovered_verified_head" && secondAttempt.data?.commit?.sha === committedHead, `second attempt should recover the same verified HEAD: ${JSON.stringify(secondAttempt.data)}`);
  assert(git(workflowRoot, ["rev-list", "--count", "HEAD"]) === String(Number(commitCountBefore) + 1), "retry must not create an empty commit");
  assert(git(workflowRoot, ["rev-parse", "HEAD"]) === committedHead, "retry must keep the exact commit object ID");
  assert(readState().phase === "ci" && readState().prNumber === 190, "successful recovery should persist ci state and PR number");
  const pushCalls = readFileSync(gitLog, "utf-8").split("\n").filter(line => line.startsWith("push "));
  assert(pushCalls.length === 2 && pushCalls.every(line => line.includes(`${committedHead}:refs/heads/feat/retry`)), `both pushes must use the exact verified SHA refspec: ${JSON.stringify(pushCalls)}`);
  const workflowPrCalls = calls();
  assert(workflowPrCalls.filter(line => line.startsWith("pr create ")).length === 1, `retry must not create a duplicate PR: ${JSON.stringify(workflowPrCalls)}`);
  assert(workflowPrCalls.every(line => line.includes("--repo github.com/o/r") && line.endsWith("GH_REPO=unset|GH_HOST=unset")), `workflow PR calls must stay bound to origin: ${JSON.stringify(workflowPrCalls)}`);

  const ci = checkCi(workflowRoot, 190);
  assert(ci.ok && ci.allGreen, `CI must accept only the still-matching verified PR head: ${JSON.stringify(ci)}`);
  const merge = mergePr(workflowRoot, 190);
  assert(merge.ok, `merge should succeed only with the persisted verified commit: ${JSON.stringify(merge)}`);
  const lifecycleCalls = calls();
  const viewCalls = lifecycleCalls.filter(line => line.startsWith("pr view "));
  const mergeCall = lifecycleCalls.find(line => line.startsWith("pr merge ")) ?? "";
  assert(viewCalls.length >= 2 && viewCalls.every(line => line.includes("--repo github.com/o/r") && line.includes("headRefOid") && line.endsWith("GH_REPO=unset|GH_HOST=unset")), `CI and merge must re-read the exact PR identity: ${JSON.stringify(viewCalls)}`);
  assert(mergeCall.includes(`--match-head-commit ${committedHead}`) && mergeCall.includes("--repo github.com/o/r") && mergeCall.endsWith("GH_REPO=unset|GH_HOST=unset"), `merge must bind the verified commit and origin: ${mergeCall}`);

  resetScenario("ci-stale");
  const staleCi = checkCi(workflowRoot, 190);
  assert(!staleCi.ok && (staleCi.error as any)?.code === "PR_HEAD_OID_MISMATCH", `CI must fail closed after the PR head moves: ${JSON.stringify(staleCi)}`);

  const attackedState = readState();
  attackedState.phase = "commit";
  writeState(attackedState);
  git(workflowRoot, ["commit", "--allow-empty", "-m", "unverified empty commit"]);
  resetScenario("workflow-retry");
  writeFileSync(gitLog, "", "utf-8");
  const attacked = await handleCommit({ title: "fix: retry safely", body: "exercise recovery" });
  assert(attacked.next === "commit" && attacked.error?.code === "GIT_RECOVERY_OID_MISMATCH", `a clean but moved HEAD must not be recovered as verified: ${JSON.stringify(attacked)}`);
  assert(!readFileSync(gitLog, "utf-8").split("\n").some(line => line.startsWith("push ")), "OID mismatch must stop before push");

  const unboundState = readState();
  unboundState.phase = "ci";
  unboundState.plan = null;
  unboundState.approval = null;
  writeState(unboundState);
  resetScenario("workflow-retry");
  const unboundCi = checkCi(workflowRoot, 190);
  assert(!unboundCi.ok && (unboundCi.error as any)?.code === "VERIFIED_COMMIT_OID_MISSING", `effective CI must not advance without a verified commit identity: ${JSON.stringify(unboundCi)}`);
  const unboundMerge = mergePr(workflowRoot, 190);
  assert(!unboundMerge.ok && (unboundMerge.error as any)?.code === "VERIFIED_COMMIT_OID_MISSING", `merge must fail closed without a verified commit identity: ${JSON.stringify(unboundMerge)}`);
  assert(!calls().some(line => line.startsWith("pr merge ")), "unbound merge must stop before invoking GitHub merge");
} finally {
  chdir(originalCwd);
  delete process.env.HY_TEST_PR_SCENARIO;
  delete process.env.HY_TEST_GH_LOG;
  delete process.env.HY_TEST_GIT_LOG;
  delete process.env.HY_TEST_RACE_MARKER;
  delete process.env.HY_TEST_PUSH_TARGET;
  delete process.env.HY_TEST_ORIGIN_OVERRIDE;
  if (originalGhRepo === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = originalGhRepo;
  if (originalGhHost === undefined) delete process.env.GH_HOST;
  else process.env.GH_HOST = originalGhHost;
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
  rmSync(runtimeHome, { recursive: true, force: true });
}
