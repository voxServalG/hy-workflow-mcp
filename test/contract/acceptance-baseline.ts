import { readFileSync } from "node:fs";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const baseline = JSON.parse(readFileSync("test/acceptance/baseline-matrix.json", "utf8"));
const release = JSON.parse(readFileSync("test/acceptance/matrix.json", "utf8"));
const workflow = readFileSync(".github/workflows/acceptance-baseline.yml", "utf8");
const releaseWorkflow = readFileSync(".github/workflows/npm-publish.yml", "utf8");
const docs = readFileSync("docs/acceptance.md", "utf8");

assert(pkg.scripts["test:acceptance:baseline"] === "npx tsx test/acceptance/baseline-runner.ts", "baseline script drift");
assert(pkg.scripts["test:acceptance:pressure"]?.includes("runner.ts --profile release"), "release pressure script drift");
assert(pkg.scripts["test:acceptance"] === "npm run test:acceptance:pressure", "release compatibility alias drift");
assert(pkg.scripts["verify:dev"] === "npm run verify && npm run test:acceptance:baseline", "dev verifier must include baseline");
assert(baseline.fixtures.length >= 6 && new Set(baseline.fixtures.map((item: any) => item.incident)).size === baseline.fixtures.length, "baseline must cover unique incident fixtures");
assert(baseline.fixtures.some((item: any) => item.incident === "INC-LINT-INTERNAL-OFFLINE"), "baseline must encode the internal offline lint incident");
for (const token of ["main", "dev", "trunk", "master", ".js", ".ts", ".py", ".rs"]) assert(JSON.stringify(baseline).includes(token), `baseline matrix missing ${token}`);
assert(release.repositories.length === 5, "release pressure matrix must contain five public repositories");
assert((releaseWorkflow.match(/actions\/checkout@/g) ?? []).length === 6, "release workflow must check out source plus five pressure repositories");
for (const token of ["name: Acceptance Baseline", "branches: [dev]", "npm run test:acceptance:baseline", "contents: read", "persist-credentials: false"]) assert(workflow.includes(token), `baseline workflow missing ${token}`);
for (const stale of ["seven repositories", "two private", "ACCEPTANCE_REPOS_TOKEN"]) assert(!docs.includes(stale), `acceptance docs retain stale claim: ${stale}`);
console.log("acceptance-baseline: scripts, incident matrix, dev workflow, and five-repository pressure contract pass");
