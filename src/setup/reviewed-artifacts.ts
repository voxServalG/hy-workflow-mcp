import fs from "node:fs";
import path from "node:path";
import { projectPaths } from "../runtime/user-paths.js";
import type { ArtifactChange } from "./types.js";

/**
 * Reviewed-artifact cache entry. Stored per-project on the OS user state root so
 * repeated --accept-artifact-changes invocations within TTL_MS milliseconds of a
 * dry-run can reuse the exact before/after hashes the user already reviewed.
 */
type ReviewedArtifactEntry = {
  file: string;
  beforeHash: string | null;
  afterHash: string;
  reviewedAt: number;
};

type ReviewedArtifactCache = {
  version: 1;
  entries: ReviewedArtifactEntry[];
};

const TTL_MS = 5 * 60 * 1000;

function cacheFile(root: string): string {
  return path.join(projectPaths(root).stateDir, "reviewed-artifacts.json");
}

function readCache(root: string): ReviewedArtifactCache {
  const file = cacheFile(root);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as ReviewedArtifactCache;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    return parsed;
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeCache(root: string, cache: ReviewedArtifactCache): void {
  const file = cacheFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
}

/**
 * Persist reviewed artifact hashes from a dry-run for up to TTL_MS.
 * Silently overwrites any prior cache for this project. No-op when running
 * under isolated acceptance (HY_WORKFLOW_ACCEPTANCE is set) so dry-run does
 * not mutate the fingerprinted user state during release pressure tests.
 */
export function cacheReviewedArtifacts(root: string, changes: Array<Pick<ArtifactChange, "file" | "beforeHash" | "afterHash">>): void {
  if (process.env.HY_WORKFLOW_ACCEPTANCE) return;
  const now = Date.now();
  writeCache(root, {
    version: 1,
    entries: changes.map(c => ({
      file: c.file,
      beforeHash: c.beforeHash,
      afterHash: c.afterHash,
      reviewedAt: now,
    })),
  });
}

/**
 * Load reviewed artifact hashes if (1) cache exists and is within TTL and
 * (2) every requested entry matches the cached beforeHash/afterHash exactly.
 * Returns null if any hash is missing, stale, or mismatched — caller must
 * then fall back to requiring explicit --review-artifact tuples.
 */
export function loadReviewedArtifacts(
  root: string,
  requested: Array<Pick<ArtifactChange, "file" | "beforeHash" | "afterHash">>,
): Array<Pick<ArtifactChange, "file" | "beforeHash" | "afterHash">> | null {
  const cache = readCache(root);
  if (!cache.entries.length) return null;
  const now = Date.now();
  const byFile = new Map(cache.entries.map(e => [e.file, e]));
  const out: Array<Pick<ArtifactChange, "file" | "beforeHash" | "afterHash">> = [];
  for (const req of requested) {
    const cached = byFile.get(req.file);
    if (!cached) return null;
    if (now - cached.reviewedAt > TTL_MS) return null;
    if (cached.beforeHash !== req.beforeHash || cached.afterHash !== req.afterHash) return null;
    out.push({ file: cached.file, beforeHash: cached.beforeHash, afterHash: cached.afterHash });
  }
  return out.length === requested.length ? out : null;
}

/**
 * Drop any reviewed-artifact cache for the project (called after a successful
 * apply so a later unrelated drift cannot reuse stale hashes).
 */
export function clearReviewedArtifacts(root: string): void {
  try {
    fs.unlinkSync(cacheFile(root));
  } catch {
    // ignore
  }
}
