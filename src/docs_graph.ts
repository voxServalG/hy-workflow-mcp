import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { projectRoot, type DocsGraph, type DocsGraphEntry, type DocsGraphLink } from "./state.js";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);

// ── Helpers ─────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function shortHash(data: string): string {
  return sha256(data).slice(0, 12);
}

function gitPrivatePath(root: string, relativePath: string): string {
  try {
    const resolved = execSync(`git rev-parse --git-path ${relativePath}`, { cwd: root })
      .toString().trim();
    return path.isAbsolute(resolved) ? resolved : path.join(root, resolved);
  } catch {
    return path.join(root, ".git", relativePath);
  }
}

function graphPath(root: string): string {
  return gitPrivatePath(root, path.join("hy-workflow", "docs-graph.json"));
}

function normalizeLink(
  fromFile: string,
  linkTarget: string,
  root: string,
  docsRoot: string
): string | null {
  // Skip anchor-only links, external URLs
  if (linkTarget.startsWith("#")) return null;
  if (linkTarget.startsWith("http://") || linkTarget.startsWith("https://")) return null;
  if (linkTarget.startsWith("mailto:")) return null;

  const targetPath = linkTarget.split(/[?#]/, 1)[0];
  if (!targetPath) return null;

  // Resolve relative to the source file's directory
  const resolved = path.resolve(path.dirname(fromFile), targetPath);
  const docsRel = path.relative(docsRoot, resolved).split(path.sep).join("/");
  if (docsRel.startsWith("..") || path.isAbsolute(docsRel)) return null; // outside docsDir, skip

  const rel = path.relative(root, resolved).split(path.sep).join("/");

  const ext = path.extname(rel).toLowerCase();
  if (!DOC_EXTENSIONS.has(ext)) return null;

  return rel;
}

// ── Graph files ─────────────────────────────────────────────

function listDocFiles(root: string, docsDir: string): string[] {
  const docsRoot = path.join(root, docsDir);
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(docsRoot);
  return files.sort();
}

function currentFileListDigest(root: string, docsDir: string): string {
  const files = listDocFiles(root, docsDir);
  // Digest based on filenames and sizes (no content read)
  const meta = files.map(f => {
    const stat = fs.statSync(path.join(root, f));
    return `${f}:${stat.size}`;
  });
  return shortHash(meta.join("|"));
}

// ── Link parsing ────────────────────────────────────────────

const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;

function parseLinks(
  content: string,
  sourceFile: string,
  root: string,
  docsRoot: string
): DocsGraphLink[] {
  const links: DocsGraphLink[] = [];
  const lines = content.split("\n");
  let cumulativeCharCount = 0;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    // Reset regex per line for consistent global matching
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(line)) !== null) {
      const anchor = m[1].trim();
      const rawTarget = m[2].trim();
      const target = normalizeLink(sourceFile, rawTarget, root, docsRoot);
      if (target) {
        links.push({ anchor, target, line: lineIdx + 1 });
      }
    }
    cumulativeCharCount += line.length + 1; // +1 for newline
  }
  return links;
}

// ── Build full graph ────────────────────────────────────────

export function buildDocsGraph(root: string, docsDir: string): DocsGraph {
  const docsRoot = path.join(root, docsDir);
  const files = listDocFiles(root, docsDir);

  // First pass: read content and extract links
  const rawEntries: Record<string, { sha: string; links: DocsGraphLink[] }> = {};
  for (const relPath of files) {
    const fullPath = path.join(root, relPath);
    const content = fs.readFileSync(fullPath, "utf-8");
    const sha = sha256(content);
    const links = parseLinks(content, fullPath, root, docsRoot);
    rawEntries[relPath] = { sha, links };
  }

  // Build reverse index
  const referencedBy: Record<string, string[]> = {};
  for (const [srcPath, entry] of Object.entries(rawEntries)) {
    for (const link of entry.links) {
      if (!referencedBy[link.target]) referencedBy[link.target] = [];
      if (!referencedBy[link.target].includes(srcPath)) {
        referencedBy[link.target].push(srcPath);
      }
    }
  }

  // Assemble entries
  const entries: Record<string, DocsGraphEntry> = {};
  for (const [relPath, raw] of Object.entries(rawEntries)) {
    entries[relPath] = {
      path: relPath,
      sha256: raw.sha,
      links: raw.links,
      referencedBy: referencedBy[relPath] ?? [],
    };
  }

  // Determine entry points
  const entryPoints = detectEntryPoints(files);

  // Graph digest
  const digestPayload = Object.keys(entries).sort().map(k => `${k}:${entries[k].sha256}`).join("|");
  const digest = shortHash(digestPayload);

  const graph: DocsGraph = { digest, docsDir, entryPoints, entries };
  saveDocsGraph(root, graph);
  return graph;
}

// ── Entry point detection ───────────────────────────────────

function detectEntryPoints(files: string[]): string[] {
  const mdFiles = files.filter(f => f.endsWith(".md"));
  // Prefer docs/index.md, then docs/README.md, then alphabetical first
  for (const candidate of ["index.md", "README.md"]) {
    const match = mdFiles.find(f => path.basename(f).toLowerCase() === candidate.toLowerCase());
    if (match) return [match];
  }
  if (mdFiles.length > 0) return [mdFiles[0]];
  // No .md files — fallback to flat: return all files (works like old behavior)
  return files;
}

// ── Persist / Load ──────────────────────────────────────────

export function saveDocsGraph(root: string, graph: DocsGraph): void {
  const p = graphPath(root);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(graph, null, 2) + "\n", "utf-8");
}

export function loadDocsGraph(root: string): DocsGraph | null {
  const p = graphPath(root);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as DocsGraph;
  } catch {
    return null;
  }
}

// ── Stale check ─────────────────────────────────────────────

export function isGraphStale(root: string, graph: DocsGraph): boolean {
  const currentDigest = currentFileListDigest(root, graph.docsDir);
  // Recompute quick digest from stored entries
  const storedPaths = Object.keys(graph.entries).sort();
  const storedDigestPayload = storedPaths.map(k => `${k}:${graph.entries[k].sha256}`).join("|");
  const storedDigest = shortHash(storedDigestPayload);
  return currentDigest !== storedDigest;
}

export function hasLegacyRelativeTargets(root: string, graph: DocsGraph): boolean {
  for (const entry of Object.values(graph.entries)) {
    for (const link of entry.links) {
      if (graph.entries[link.target]) continue;
      if (link.target.startsWith(`${graph.docsDir}/`)) continue;
      if (fs.existsSync(path.join(root, graph.docsDir, link.target))) return true;
    }
  }
  return false;
}

// ── Task-driven BFS traversal ───────────────────────────────

export interface TraversalResult {
  read: string[];            // paths actually read (full content)
  visited: string[];         // all paths visited during BFS
  sourcePaths: string[][];   // for each read file, which inbound edges led to it
  entryPoints: string[];
}

interface MatchResult {
  anchor: string;
  target: string;
  score: number;
}

function tokenize(text: string): Set<string> {
  // lowercase, split on non-word chars, remove empties
  const words = text.toLowerCase().split(/[^a-z0-9_\-\u4e00-\u9fff]+/);
  return new Set(words.filter(w => w.length > 0));
}

function matchScore(anchor: string, target: string, task: string): number {
  const taskTokens = tokenize(task);
  if (taskTokens.size === 0) return 0;

  const anchorTokens = tokenize(anchor);
  const baseName = path.basename(target, path.extname(target));
  const targetTokens = tokenize(baseName);

  // Check anchor intersection
  for (const t of taskTokens) {
    if (anchorTokens.has(t)) return 1.0;
  }

  // Check filename intersection
  for (const t of taskTokens) {
    if (targetTokens.has(t)) return 0.5;
  }

  // Check if task contains the anchor text as substring (e.g. "read_docs" in "hy_read_docs")
  const anchorLower = anchor.toLowerCase();
  const taskLower = task.toLowerCase();
  if (anchorLower.length > 0 && taskLower.includes(anchorLower)) return 0.8;

  return 0;
}

export function traverseByTask(
  root: string,
  graph: DocsGraph,
  task: string,
  extraEntryPoints: string[] = []
): TraversalResult {
  const visited = new Set<string>();
  const read: string[] = [];
  const sourcePaths: string[][] = [];
  const entryPoints = [...graph.entryPoints, ...extraEntryPoints];

  // Deduplicate entry points
  const dedupedEntryPoints: string[] = [];
  for (const ep of entryPoints) {
    if (!dedupedEntryPoints.includes(ep)) dedupedEntryPoints.push(ep);
  }

  // BFS queue: [path, sources[]]
  interface QueueItem { path: string; sources: string[]; }
  const queue: QueueItem[] = dedupedEntryPoints.map(ep => ({ path: ep, sources: ["<entry>"] }));

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visited.has(item.path)) continue;
    visited.add(item.path);

    const entry = graph.entries[item.path];
    if (!entry) continue; // file not in graph (deleted?)

    // Read the file
    const fullPath = path.join(root, item.path);
    if (fs.existsSync(fullPath)) {
      read.push(item.path);
      sourcePaths.push(item.sources);
    }

    // Evaluate outgoing links
    for (const link of entry.links) {
      // Always traverse entry points regardless of score
      const score = matchScore(link.anchor, link.target, task);
      if (score > 0 || dedupedEntryPoints.includes(link.target)) {
        // Only enqueue if not visited
        if (!visited.has(link.target)) {
          queue.push({ path: link.target, sources: [item.path] });
        }
      }
    }
  }

  // Fallback: if no files were matched via graph, use entry points
  if (read.length === 0) {
    for (const ep of dedupedEntryPoints) {
      if (fs.existsSync(path.join(root, ep))) {
        read.push(ep);
        sourcePaths.push(["<entry>"]);
      }
    }
  }

  return {
    read,
    visited: [...visited],
    sourcePaths,
    entryPoints: dedupedEntryPoints,
  };
}

// ── Incremental update ──────────────────────────────────────

export function incrementalUpdate(
  root: string,
  graph: DocsGraph,
  changedFiles: string[]
): DocsGraph {
  const docsRoot = path.join(root, graph.docsDir);
  const updated = { ...graph, entries: { ...graph.entries } };

  for (const cf of changedFiles) {
    const fullPath = path.join(root, cf);
    if (!fs.existsSync(fullPath)) {
      // File deleted
      const oldEntry = updated.entries[cf];
      if (oldEntry) {
        // Remove from referencedBy of targets
        for (const link of oldEntry.links) {
          const targetEntry = updated.entries[link.target];
          if (targetEntry) {
            targetEntry.referencedBy = targetEntry.referencedBy.filter(s => s !== cf);
          }
        }
        delete updated.entries[cf];
      }
      continue;
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const sha = sha256(content);
    const oldEntry = updated.entries[cf];

    // Parse links fresh
    const oldLinks = oldEntry?.links ?? [];
    const newLinks = parseLinks(content, fullPath, root, docsRoot);

    // Update reverse index: remove old links, add new links
    for (const oldLink of oldLinks) {
      const targetEntry = updated.entries[oldLink.target];
      if (targetEntry) {
        targetEntry.referencedBy = targetEntry.referencedBy.filter(s => s !== cf);
      }
    }
    for (const newLink of newLinks) {
      if (!updated.entries[newLink.target]) {
        // Target exists but not yet in graph — create stub
        const targetFull = path.join(root, newLink.target);
        if (fs.existsSync(targetFull)) {
          const targetContent = fs.readFileSync(targetFull, "utf-8");
          updated.entries[newLink.target] = {
            path: newLink.target,
            sha256: sha256(targetContent),
            links: parseLinks(targetContent, targetFull, root, docsRoot),
            referencedBy: [cf],
          };
        }
      } else {
        const targetEntry = updated.entries[newLink.target];
        if (!targetEntry.referencedBy.includes(cf)) {
          targetEntry.referencedBy.push(cf);
        }
      }
    }

    // Update entry
    updated.entries[cf] = {
      path: cf,
      sha256: sha,
      links: newLinks,
      referencedBy: oldEntry?.referencedBy ?? [],
    };
  }

  // Also detect orphans: files in graph that no longer exist on disk
  for (const [p, entry] of Object.entries(updated.entries)) {
    if (!fs.existsSync(path.join(root, p))) {
      delete updated.entries[p];
    }
  }

  // Recompute digest
  const paths = Object.keys(updated.entries).sort();
  const digestPayload = paths.map(k => `${k}:${updated.entries[k].sha256}`).join("|");
  updated.digest = shortHash(digestPayload);

  // Re-detect entry points (docs might have been deleted)
  updated.entryPoints = detectEntryPoints(paths);

  saveDocsGraph(root, updated);
  return updated;
}

// ── Broken link detection ───────────────────────────────────

export interface BrokenLink {
  source: string;
  target: string;
  anchor: string;
  line: number;
}

export function detectBrokenLinks(
  entries: Record<string, DocsGraphEntry>,
  root: string
): BrokenLink[] {
  const broken: BrokenLink[] = [];
  for (const [srcPath, entry] of Object.entries(entries)) {
    for (const link of entry.links) {
      const fullTarget = path.join(root, link.target);
      if (!fs.existsSync(fullTarget)) {
        broken.push({ source: srcPath, target: link.target, anchor: link.anchor, line: link.line });
      }
    }
  }
  return broken;
}

// ── Convenience: ensure graph is current ────────────────────

export function ensureGraph(root: string, docsDir: string): DocsGraph {
  const existing = loadDocsGraph(root);
  if (existing && existing.docsDir === docsDir && !isGraphStale(root, existing) && !hasLegacyRelativeTargets(root, existing)) {
    return existing;
  }
  return buildDocsGraph(root, docsDir);
}
