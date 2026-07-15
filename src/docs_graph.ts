import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { projectRoot, type DocsGraph, type DocsGraphEntry, type DocsGraphLink } from "./state.js";
import { DOC_EXTENSIONS, isDocumentPath, pathInsideDocs, relativeInside, relativeToDocs, resolveDocsDir } from "./docs_paths.js";
import { atomicWriteJson, projectPaths } from "./runtime/user-paths.js";
import { resolveGitPrivatePath } from "./runtime/project.js";

const GRAPH_DIGEST_VERSION = "docs-graph-v2";

// ── Helpers ─────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function shortHash(data: string): string {
  return sha256(data).slice(0, 12);
}

function graphDigestFromFileShas(items: string[]): string {
  return shortHash(`${GRAPH_DIGEST_VERSION}|${items.join("|")}`);
}

function graphPath(root: string): string {
  return projectPaths(root).docsGraph;
}

function legacyGraphPath(root: string): string {
  return resolveGitPrivatePath(root, path.join("hy-workflow", "docs-graph.json"));
}

function normalizeLink(
  fromFile: string,
  linkTarget: string,
  root: string,
  docsRoot: string
): string | null {
  const rawTargetPath = extractTargetPath(linkTarget);
  if (!rawTargetPath) return null;

  // Skip anchor-only links, external URLs
  if (rawTargetPath.startsWith("#")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawTargetPath)) return null;

  const targetPath = safeDecodeUri(rawTargetPath.split(/[?#]/, 1)[0]);
  if (!targetPath) return null;

  // Resolve relative to the source file's directory
  const resolved = path.resolve(path.dirname(fromFile), targetPath);
  const docsRel = relativeToDocs(docsRoot, resolved);
  if (!docsRel) return null; // outside docsDir, skip

  const rel = relativeInside(root, resolved);
  if (!rel) return null;

  const ext = path.extname(rel).toLowerCase();
  if (!DOC_EXTENSIONS.has(ext)) return null;

  return rel;
}

function safeDecodeUri(targetPath: string): string | null {
  try {
    return decodeURI(targetPath);
  } catch {
    return null;
  }
}

function extractTargetPath(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    return close === -1 ? "" : trimmed.slice(1, close).trim();
  }

  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    else if (/\s/.test(ch) && depth === 0) return trimmed.slice(0, i);
  }
  return trimmed;
}

// ── Graph files ─────────────────────────────────────────────

function listDocFiles(root: string, docsDir: string): string[] {
  const resolvedDocsDir = resolveDocsDir(root, docsDir);
  if (!resolvedDocsDir.ok) throw new Error(resolvedDocsDir.error);
  const { docsRoot } = resolvedDocsDir;
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!isDocumentPath(entry.name)) continue;
      files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(docsRoot);
  return files.sort();
}

function currentGraphDigest(root: string, docsDir: string): string {
  const files = listDocFiles(root, docsDir);
  const meta = files.map(f => {
    const content = fs.readFileSync(path.join(root, f), "utf-8");
    return `${f}:${sha256(content)}`;
  });
  return graphDigestFromFileShas(meta);
}

// ── Link parsing ────────────────────────────────────────────

const REFERENCE_DEFINITION_RE = /^\s{0,3}\[([^\]]+)\]:\s*(.+)$/;
const REFERENCE_LINK_RE = /\[((?:\\.|[^\]\\])*)\]\[([^\]]*)\]/g;

function fenceMarker(line: string): "`" | "~" | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return match[1][0] === "`" ? "`" : "~";
}

function stripInlineCodeSpans(line: string): string {
  let result = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "`") {
      result += line[i];
      continue;
    }

    let tickCount = 1;
    while (line[i + tickCount] === "`") tickCount++;
    const marker = "`".repeat(tickCount);
    const end = line.indexOf(marker, i + tickCount);
    if (end === -1) {
      result += line.slice(i);
      break;
    }
    result += " ".repeat(end + tickCount - i);
    i = end + tickCount - 1;
  }
  return result;
}

function linkScannableLines(content: string): Array<{ line: string; number: number }> {
  const result: Array<{ line: string; number: number }> = [];
  const lines = content.split("\n");
  let activeFence: "`" | "~" | null = null;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const raw = lines[lineIdx];
    const marker = fenceMarker(raw);
    if (marker && (!activeFence || activeFence === marker)) {
      activeFence = activeFence ? null : marker;
      continue;
    }
    if (activeFence) continue;
    result.push({ line: stripInlineCodeSpans(raw), number: lineIdx + 1 });
  }

  return result;
}

function referenceLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function collectReferenceDefinitions(lines: string[]): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const line of lines) {
    const match = REFERENCE_DEFINITION_RE.exec(line);
    if (!match) continue;
    const label = referenceLabel(match[1]);
    const target = extractTargetPath(match[2]);
    if (label && target) definitions.set(label, target);
  }
  return definitions;
}

function parseInlineLinks(
  line: string,
  lineNumber: number,
  sourceFile: string,
  root: string,
  docsRoot: string
): DocsGraphLink[] {
  const links: DocsGraphLink[] = [];
  let searchFrom = 0;

  while (searchFrom < line.length) {
    const open = line.indexOf("[", searchFrom);
    if (open === -1) break;
    if (open > 0 && line[open - 1] === "!") {
      searchFrom = open + 1;
      continue;
    }

    const close = line.indexOf("]", open + 1);
    if (close === -1) break;
    if (line[close + 1] !== "(") {
      searchFrom = close + 1;
      continue;
    }

    const targetStart = close + 2;
    let depth = 0;
    let targetEnd = -1;
    for (let i = targetStart; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "(") {
        depth++;
        continue;
      }
      if (ch === ")") {
        if (depth === 0) {
          targetEnd = i;
          break;
        }
        depth--;
      }
    }

    if (targetEnd === -1) break;
    const anchor = line.slice(open + 1, close).trim();
    const rawTarget = line.slice(targetStart, targetEnd).trim();
    const target = normalizeLink(sourceFile, rawTarget, root, docsRoot);
    if (target) links.push({ anchor, target, line: lineNumber });
    searchFrom = targetEnd + 1;
  }

  return links;
}

function parseReferenceLinks(
  line: string,
  lineNumber: number,
  definitions: Map<string, string>,
  sourceFile: string,
  root: string,
  docsRoot: string
): DocsGraphLink[] {
  if (REFERENCE_DEFINITION_RE.test(line)) return [];

  const links: DocsGraphLink[] = [];
  REFERENCE_LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REFERENCE_LINK_RE.exec(line)) !== null) {
    const anchor = match[1].trim();
    const label = referenceLabel(match[2] || anchor);
    const rawTarget = definitions.get(label);
    if (!rawTarget) continue;
    const target = normalizeLink(sourceFile, rawTarget, root, docsRoot);
    if (target) links.push({ anchor, target, line: lineNumber });
  }
  return links;
}

function parseLinks(
  content: string,
  sourceFile: string,
  root: string,
  docsRoot: string
): DocsGraphLink[] {
  const links: DocsGraphLink[] = [];
  const lines = linkScannableLines(content);
  const definitions = collectReferenceDefinitions(lines.map(item => item.line));
  for (const item of lines) {
    links.push(...parseInlineLinks(item.line, item.number, sourceFile, root, docsRoot));
    links.push(...parseReferenceLinks(item.line, item.number, definitions, sourceFile, root, docsRoot));
  }
  return links;
}

// ── Build full graph ────────────────────────────────────────

export function buildDocsGraph(root: string, docsDir: string): DocsGraph {
  const resolvedDocsDir = resolveDocsDir(root, docsDir);
  if (!resolvedDocsDir.ok) throw new Error(resolvedDocsDir.error);
  const { docsRoot } = resolvedDocsDir;
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
  const digestPayload = Object.keys(entries).sort().map(k => `${k}:${entries[k].sha256}`);
  const digest = graphDigestFromFileShas(digestPayload);

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
  atomicWriteJson(graphPath(root), graph);
}

export function loadDocsGraph(root: string): DocsGraph | null {
  const p = graphPath(root);
  const source = fs.existsSync(p) ? p : legacyGraphPath(root);
  if (!fs.existsSync(source)) return null;
  try {
    const graph = JSON.parse(fs.readFileSync(source, "utf-8")) as DocsGraph;
    if (source !== p) saveDocsGraph(root, graph);
    return graph;
  } catch {
    return null;
  }
}

// ── Stale check ─────────────────────────────────────────────

export function isGraphStale(root: string, graph: DocsGraph): boolean {
  try {
    return currentGraphDigest(root, graph.docsDir) !== graph.digest;
  } catch {
    return true;
  }
}

export function hasLegacyRelativeTargets(root: string, graph: DocsGraph): boolean {
  for (const entry of Object.values(graph.entries)) {
    for (const link of entry.links) {
      if (graph.entries[link.target]) continue;
      if (pathInsideDocs(root, graph.docsDir, link.target)) continue;
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
    if (!entry) {
      const fullPath = path.join(root, item.path);
      if (fs.existsSync(fullPath) && isDocumentPath(item.path)) {
        read.push(item.path);
        sourcePaths.push(item.sources);
      }
      continue; // file not in graph (deleted or supplemental outside docsDir)
    }

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
  const resolvedDocsDir = resolveDocsDir(root, graph.docsDir);
  if (!resolvedDocsDir.ok) throw new Error(resolvedDocsDir.error);
  const { docsRoot } = resolvedDocsDir;
  const updated = { ...graph, entries: { ...graph.entries } };

  for (const cf of changedFiles) {
    if (!pathInsideDocs(root, graph.docsDir, cf)) continue;
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
  const digestPayload = paths.map(k => `${k}:${updated.entries[k].sha256}`);
  updated.digest = graphDigestFromFileShas(digestPayload);

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
