import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { buildDocsGraph, ensureGraph, isGraphStale } from "../../src/docs_graph.js";

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
assert(!targets.includes("https://example.com/out.md"), "external links should not enter DocsGraph");
assert(!targets.includes("README.md"), "links outside docsDir should not enter DocsGraph");
assert(graph.entries["docs/reference.md"].referencedBy.includes("docs/index.md"), "reference target should record inbound edge");
assert(!isGraphStale(root, graph), "freshly built graph should not be stale");

const graphFile = path.join(root, ".git", "hy-workflow", "docs-graph.json");
const cached = JSON.parse(fs.readFileSync(graphFile, "utf-8"));
cached.sentinel = "cache-hit";
fs.writeFileSync(graphFile, JSON.stringify(cached, null, 2) + "\n", "utf-8");

const ensured = ensureGraph(root, "docs") as typeof graph & { sentinel?: string };
assert(ensured.sentinel === "cache-hit", "unchanged graph should be loaded from cache instead of rewritten");

write(root, "docs/usage guide.md", "bbbbbbbbbb\n");
const refreshed = ensureGraph(root, "docs") as typeof graph & { sentinel?: string };
assert(refreshed.sentinel !== "cache-hit", "same-size content changes should invalidate the cached graph");
assert(!isGraphStale(root, refreshed), "refreshed graph should be current after rebuild");
