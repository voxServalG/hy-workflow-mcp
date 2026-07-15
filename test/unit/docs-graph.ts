import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { buildDocsGraph, ensureGraph, isGraphStale } from "../../src/docs_graph.js";
import { projectPaths } from "../../src/runtime/user-paths.js";

const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), "hy-docs-graph-runtime-"));
process.env.HY_WORKFLOW_CONFIG_HOME = path.join(runtimeHome, "config");
process.env.HY_WORKFLOW_STATE_HOME = path.join(runtimeHome, "state");
process.env.HY_WORKFLOW_CACHE_HOME = path.join(runtimeHome, "cache");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function write(root: string, file: string, content: string): void {
  const fullPath = path.join(root, file);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-docs-graph-"));
execSync("git init", { cwd: root, stdio: "ignore" });

write(root, "docs/index.md", [
  "# Index",
  "[Usage](./usage%20guide.md)",
  "[API](./api(v1).md)",
  "[Reference][usage-ref]",
  "`[Inline Code](./inline-code.md)`",
  "```",
  "[Fenced Code](./fenced-code.md)",
  "```",
  "[External](https://example.com/out.md)",
  "[Outside](../README.md)",
  "",
  "[usage-ref]: ./reference.md",
  "",
].join("\n"));
write(root, "docs/usage guide.md", "aaaaaaaaaa\n");
write(root, "docs/api(v1).md", "# API\n");
write(root, "docs/reference.md", "# Reference\n");
write(root, "README.md", "# Outside docs\n");

const graph = buildDocsGraph(root, "docs");
const index = graph.entries["docs/index.md"];
assert(index !== undefined, "index entry should exist");
const targets = index.links.map(link => link.target).sort();
assert(targets.includes("docs/usage guide.md"), `URL encoded target should decode into docs path: ${targets.join(", ")}`);
assert(targets.includes("docs/api(v1).md"), `inline target with parentheses should parse: ${targets.join(", ")}`);
assert(targets.includes("docs/reference.md"), `reference-style target should parse: ${targets.join(", ")}`);
assert(!targets.includes("docs/inline-code.md"), "inline code links should not enter DocsGraph");
assert(!targets.includes("docs/fenced-code.md"), "fenced code links should not enter DocsGraph");
assert(!targets.includes("https://example.com/out.md"), "external links should not enter DocsGraph");
assert(!targets.includes("README.md"), "links outside docsDir should not enter DocsGraph");
assert(graph.entries["docs/reference.md"].referencedBy.includes("docs/index.md"), "reference target should record inbound edge");
assert(!isGraphStale(root, graph), "freshly built graph should not be stale");

write(root, "doc/index.md", "# Doc\n\n[Outside Prefix](../doc-extra/outside.md)\n");
write(root, "doc-extra/outside.md", "# Outside prefix\n");
const prefixGraph = buildDocsGraph(root, "doc");
assert(!prefixGraph.entries["doc/index.md"].links.some(link => link.target === "doc-extra/outside.md"), "docsDir=doc must not include doc-extra by string prefix");

try {
  buildDocsGraph(root, "../outside-docs");
  throw new Error("buildDocsGraph should reject docsDir outside the repository root");
} catch (error: any) {
  assert(String(error?.message ?? error).includes("must not contain parent segments"), `unexpected docsDir error: ${String(error?.message ?? error)}`);
}

const rootDocsGraph = buildDocsGraph(root, ".");
assert(rootDocsGraph.entries["docs/index.md"] !== undefined, "docsDir=. should be accepted as the project root");

buildDocsGraph(root, "docs");
const graphFile = projectPaths(root).docsGraph;
const cached = JSON.parse(fs.readFileSync(graphFile, "utf-8"));
cached.sentinel = "cache-hit";
fs.writeFileSync(graphFile, JSON.stringify(cached, null, 2) + "\n", "utf-8");

const ensured = ensureGraph(root, "docs") as typeof graph & { sentinel?: string };
assert(ensured.sentinel === "cache-hit", "unchanged graph should be loaded from cache instead of rewritten");

write(root, "docs/usage guide.md", "bbbbbbbbbb\n");
const refreshed = ensureGraph(root, "docs") as typeof graph & { sentinel?: string };
assert(refreshed.sentinel !== "cache-hit", "same-size content changes should invalidate the cached graph");
assert(!isGraphStale(root, refreshed), "refreshed graph should be current after rebuild");
