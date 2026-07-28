import { readFileSync } from "node:fs";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const baseline = JSON.parse(readFileSync("test/acceptance/baseline-matrix.json", "utf8"));
const release = JSON.parse(readFileSync("test/acceptance/matrix.json", "utf8"));
const workflow = readFileSync(".github/workflows/acceptance-baseline.yml", "utf8");
const releaseWorkflow = readFileSync(".github/workflows/npm-publish.yml", "utf8");
const docs = readFileSync("docs/acceptance.md", "utf8");
const baselineRunner = readFileSync("test/acceptance/baseline-runner.ts", "utf8");
const baselineScenarios = readFileSync("test/acceptance/baseline-scenarios.ts", "utf8");
const mergeRecoveryIncident = readFileSync("test/acceptance/merge-recovery-incident.ts", "utf8");

assert(pkg.scripts["test:acceptance:baseline"] === "npx tsx test/acceptance/baseline-runner.ts", "baseline script drift");
assert(pkg.scripts["test:acceptance:pressure"]?.includes("runner.ts --profile release"), "release pressure script drift");
assert(pkg.scripts["test:acceptance"] === "npm run test:acceptance:pressure", "release compatibility alias drift");
assert(pkg.scripts["verify:dev"] === "npm run verify && npm run test:acceptance:baseline", "dev verifier must include baseline");
assert(baseline.fixtures.length >= 7 && new Set(baseline.fixtures.map((item: any) => item.incident)).size === baseline.fixtures.length, "baseline must cover unique incident fixtures");
assert(baseline.fixtures.some((item: any) => item.incident === "INC-LINT-INTERNAL-OFFLINE"), "baseline must encode the internal offline lint incident");
const mergeRecoveryFixtures = baseline.fixtures.filter((item: any) => item.kind === "merge-recovery" && item.incident === "INC-MERGE-UNKNOWN-OUTCOME");
assert(mergeRecoveryFixtures.length === 1, "baseline must encode exactly one merge unknown-outcome incident fixture");
assert(baselineScenarios.includes('fixture.kind === "merge-recovery"') && baselineScenarios.includes("runMergeRecoveryIncident"), "baseline scenarios must dispatch the merge incident to its executable oracle");
for (const token of ["HY_ACCEPTANCE_PACKAGE_ROOT", 'dist", "tools", "merge.js', "remote-success-error", "unavailable-after-merge", "handleMerge", "POST_MERGE_SYNC_INCOMPLETE", 'retry.data?.evidence === "git"', 'retry.data?.outcome === "already_integrated"', "read-only Git fallback must never push", "retryOutcome", "remoteMergeCalls: 1"]) {
  assert(mergeRecoveryIncident.includes(token), `merge recovery incident is missing installed-package oracle token: ${token}`);
}
assert(baselineRunner.includes("INC-MERGE-UNKNOWN-OUTCOME") && baselineRunner.includes("completedIncidents") && baselineRunner.includes("incidents: completedIncidents"), "baseline runner must count and report the executed merge incident");
for (const token of ["main", "dev", "trunk", "master", ".js", ".ts", ".py", ".rs"]) assert(JSON.stringify(baseline).includes(token), `baseline matrix missing ${token}`);
assert(release.repositories.length === 5, "release pressure matrix must contain five public repositories");
assert((releaseWorkflow.match(/actions\/checkout@/g) ?? []).length === 6, "release workflow must check out source plus five pressure repositories");
for (const token of ["name: Acceptance Baseline", "branches: [dev]", "npm run test:acceptance:baseline", "contents: read", "persist-credentials: false"]) assert(workflow.includes(token), `baseline workflow missing ${token}`);
for (const stale of ["seven repositories", "two private", "ACCEPTANCE_REPOS_TOKEN"]) assert(!docs.includes(stale), `acceptance docs retain stale claim: ${stale}`);
console.log("acceptance-baseline: scripts, incident matrix, dev workflow, and five-repository pressure contract pass");
