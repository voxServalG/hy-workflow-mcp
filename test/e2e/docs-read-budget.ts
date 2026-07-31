import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildDocsGraph } from "../../src/docs_graph.js";
import { DOCUMENT_READ_BUDGET } from "../../src/policy/docs.js";
import { RUNTIME_CONFIG_SOURCE_ENV, RUNTIME_CONFIG_SOURCE_SCHEMA } from "../../src/config.js";
import { readState, writeState, type WorkflowState } from "../../src/state.js";
import { handleReadDocs } from "../../src/tools/read_docs.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";

process.env[RUNTIME_CONFIG_SOURCE_ENV] = RUNTIME_CONFIG_SOURCE_SCHEMA;

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
}

function init(root: string, docsDir = "docs"): void {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  write(root, "src/app.ts", "export const app = true;\n");
  write(root, "hy-workflow.json", JSON.stringify({
    project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir },
    codelint: { lintDirs: ["src"] },
  }, null, 2) + "\n");
}

function planState(): WorkflowState {
  return {
    version: "1", phase: "plan", branch: null, prNumber: null, plan: null,
    approval: null, verifyHash: null,
  };
}

useRuntimeHome("hy-doc-budget-home-");
const originalCwd = process.cwd();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-doc-budget-"));

try {
  init(root);
  write(root, "AGENTS.md", [
    "<!-- hy-workflow-rules -->",
    "<!-- hy-workflow-rules-version: legacy -->",
    "Use the documented workflow and preserve project boundaries.",
    "<!-- /hy-workflow-rules -->",
    "",
  ].join("\n"));
  const links: string[] = ["# Documentation", "", "Setup behavior and recovery facts.", ""];
  for (let i = 0; i < 24; i++) {
    const file = `docs/topic-${String(i).padStart(2, "0")}.md`;
    links.push(`[Setup topic ${i}](./topic-${String(i).padStart(2, "0")}.md)`);
    write(root, file, `# Setup topic ${i}\n\n${"A maintained setup fact and recovery expectation. ".repeat(500)}\n`);
  }
  write(root, "docs/INDEX.rst", [
    "Documentation", "=============", "", "The RST entry point contains release and setup facts.", "",
  ].join("\n"));
  write(root, "docs/index.md", links.join("\n") + "\n");
  write(root, "docs/node_modules/dependency/README.md", "# Dependency\n\nThis must never enter project facts.\n");
  write(root, "docs/examples/demo.md", "# Example\n\nThis fixture must never enter project facts.\n");
  write(root, "docs/generated/api.md", "# Generated\n\nGenerated material must never enter project facts.\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "docs"]);
  fs.chmodSync(path.join(root, "AGENTS.md"), 0o000);
  process.chdir(root);

  const graph = buildDocsGraph(root, "docs");
  assert(!Object.keys(graph.entries).some(file => /node_modules|examples|generated/.test(file)), "DocsGraph must exclude dependency, example, fixture, and generated trees");
  assert(graph.entryPoints[0] === "docs/index.md" || graph.entryPoints[0] === "docs/INDEX.rst", `root index should beat nested README: ${graph.entryPoints.join(", ")}`);

  writeState(planState());
  const result = await handleReadDocs({ stage: "before_plan", task: "harden setup recovery and release", cursor: undefined });
  assert(result.phase === "plan" && result.snapshot, `bounded document read should succeed: ${JSON.stringify(result)}`);
  const snapshot = result.snapshot;
  const chars = snapshot.files.reduce((sum: number, file: any) => sum + file.content.length, 0);
  assert(snapshot.files.length <= DOCUMENT_READ_BUDGET.maxFiles, "document read must enforce its file budget");
  assert(chars <= DOCUMENT_READ_BUDGET.maxChars, "document read must enforce its character budget");
  assert(snapshot.files.every((file: any) => file.content.length <= DOCUMENT_READ_BUDGET.maxFileChars + 100), "each excerpt must be bounded");
  assert(snapshot.pagination.hasMore && snapshot.pagination.nextCursor, "large relevant documentation should expose a stable next cursor");
  assert(snapshot.budget.estimatedTokens <= DOCUMENT_READ_BUDGET.estimatedMaxTokens, "estimated token use must stay within policy");

  const persisted = readState().documentReads?.beforePlan;
  assert(persisted?.files.every(file => file.content === undefined), "workflow state must store document digests/metadata, not returned excerpts or full text");
  assert(fs.statSync(path.join(process.env.HY_WORKFLOW_STATE_HOME!, "projects")).isDirectory(), "workflow state should remain external");

  const pageTwo = await handleReadDocs({ stage: "before_plan", task: "harden setup recovery and release", cursor: snapshot.pagination.nextCursor });
  assert(pageTwo.snapshot?.pagination.offset > 0, "a returned cursor should retrieve a bounded later page");
  const staleCursor = await handleReadDocs({ stage: "before_plan", task: "harden setup recovery and release", cursor: "docs:000000000000:12" });
  assert(staleCursor.error?.code === "DOCS_CURSOR_INVALID" && staleCursor.stop_here, "a stale cursor must fail closed instead of silently rereading page one");

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-doc-empty-"));
  init(emptyRoot);
  fs.mkdirSync(path.join(emptyRoot, "docs"), { recursive: true });
  git(emptyRoot, ["add", "."]);
  git(emptyRoot, ["commit", "-m", "empty docs"]);
  process.chdir(emptyRoot);
  writeState(planState());
  const empty = await handleReadDocs({ stage: "before_plan", task: "plan a feature" });
  assert(empty.error?.code === "DOCS_EMPTY" && empty.stop_here, `empty docs must fail closed: ${JSON.stringify(empty)}`);

  const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-doc-stale-agents-"));
  init(staleRoot);
  write(staleRoot, "docs/index.md", "# Maintained facts\n\nProject constraints and verification.\n");
  write(staleRoot, "AGENTS.md", [
    "<!-- hy-workflow-rules -->",
    "<!-- hy-workflow-rules-version: 2025.01.01.1 -->",
    "Choose deployment mode: local mode or shared mode.",
    "<!-- /hy-workflow-rules -->",
  ].join("\n"));
  git(staleRoot, ["add", "."]);
  git(staleRoot, ["commit", "-m", "stale rules"]);
  fs.chmodSync(path.join(staleRoot, "AGENTS.md"), 0o000);
  process.chdir(staleRoot);
  writeState(planState());
  const stale = await handleReadDocs({ stage: "before_plan", task: "plan a feature" });
  assert(stale.phase === "plan" && stale.snapshot, `legacy AGENTS.md must not block configured document reading: ${JSON.stringify(stale)}`);
  assert(!stale.snapshot.files.some((file: any) => file.path === "AGENTS.md"), "legacy AGENTS.md must not enter the document snapshot");
  fs.chmodSync(path.join(staleRoot, "AGENTS.md"), 0o644);
} finally {
  try { fs.chmodSync(path.join(root, "AGENTS.md"), 0o644); } catch {}
  process.chdir(originalCwd);
}
