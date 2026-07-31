import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  assertPhase,
  computePlanHash,
  projectRoot,
  readState,
  writeState,
  type ImplementationManifest,
  type PlanDoc,
} from "../state.js";
import { buildImplementationManifest } from "../checks.js";
import { ensureGraph, incrementalUpdate, detectBrokenLinks } from "../docs_graph.js";
import { isDocumentPath, pathInsideDocs, resolveDocsDir } from "../docs_paths.js";
import { toolResult, type ToolResult } from "./_base.js";
import { requireRuntimeConfig } from "../config.js";
import { shouldIgnoreDocumentPath } from "../policy/docs.js";
import { isRuntimeIgnoredArtifact } from "../policy/artifacts.js";

export function isSyncDocumentPath(file: string): boolean {
  if (shouldIgnoreDocumentPath(file)) return false;
  return file === "README.md"
    || file.startsWith("templates/")
    || file.startsWith("docs/")
    || isDocumentPath(file);
}

export function allowedSyncDocumentPaths(plan: PlanDoc): string[] {
  const declared = [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete];
  return declared.filter(isSyncDocumentPath).sort();
}

function shortHash(value: string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex").slice(0, 12);
}

export function implementationFilesForDigest(plan: PlanDoc, manifest: ImplementationManifest): string[] {
  const allowedDocs = new Set(allowedSyncDocumentPaths(plan));
  return manifest.changed.filter(file => !allowedDocs.has(file)).sort();
}

export function implementationDigest(root: string, plan: PlanDoc, manifest: ImplementationManifest): string {
  const files = implementationFilesForDigest(plan, manifest).map(file => {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) return { file, sha256: "deleted" };
    const hash = createHash("sha256");
    hash.update(fs.readFileSync(fullPath));
    return { file, sha256: hash.digest("hex") };
  });
  return shortHash(JSON.stringify(files));
}

function readDocsDir(root: string): string {
  return requireRuntimeConfig(root).project.docsDir as string;
}

export async function handleSyncDocs(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "edit", "verify");

  if (!state.plan) return toolResult("edit", { phase: state.phase, error: "No plan", allowedTools: ["hy_status"] });

  const planHash = computePlanHash(state.plan);
  const afterEdit = state.documentReads?.afterEdit;
  if (!planHash || afterEdit?.planHash !== planHash) {
    return toolResult("edit", {
      phase: state.phase,
      error: "after_edit document audit is required before hy_sync_docs.",
      hint: "Call hy_read_docs with { stage: \"after_edit\" } after implementation edits, then call hy_sync_docs before hy_verify.",
      allowedTools: ["hy_read_docs", "hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    });
  }

  const root = projectRoot();
  let configuredDocsDir: string;
  try {
    configuredDocsDir = readDocsDir(root);
  } catch (error) {
    return toolResult("edit", {
      phase: state.phase,
      error,
      hint: "Run hy-workflow setup in the project root, then retry hy_sync_docs.",
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    });
  }

  const manifest = buildImplementationManifest(root);
  const currentImplementationDigest = implementationDigest(root, state.plan, manifest);
  if (afterEdit.implementationDigest !== currentImplementationDigest) {
    return toolResult("edit", {
      phase: state.phase,
      error: "Implementation diff changed after hy_read_docs(after_edit).",
      hint: "Rerun hy_read_docs with { stage: \"after_edit\" } so the document sync audit matches the current implementation diff.",
      allowedTools: ["hy_read_docs", "hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    });
  }

  if (isRuntimeIgnoredArtifact(root, configuredDocsDir)) {
    return toolResult("edit", {
      phase: state.phase,
      error: "Configured project.docsDir points to an ignored legacy or runtime path.",
      hint: "Choose a maintained documentation directory outside legacy injection and runtime paths.",
      allowedTools: ["hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    });
  }
  const resolvedDocsDir = resolveDocsDir(root, configuredDocsDir);
  if (!resolvedDocsDir.ok) {
    return toolResult("edit", {
      phase: state.phase,
      error: `Invalid project.docsDir: ${resolvedDocsDir.error}`,
      hint: "Update project.docsDir in the authoritative project configuration to a project-relative directory inside the repository.",
      allowedTools: ["hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
    });
  }
  const { docsDir } = resolvedDocsDir;
  const allowedDocs = allowedSyncDocumentPaths(state.plan);

  // ── Incremental graph update ──────────────────────────────
  const graphChangedDocs = allowedDocs.filter(doc => pathInsideDocs(root, docsDir, doc));
  let graphInfo = { updated: false, brokenLinks: 0, brokenLinkDetails: [] as string[] };

  if (graphChangedDocs.length > 0) {
    // Ensure graph is current before updating
    const graph = ensureGraph(root, docsDir);
    const updated = incrementalUpdate(root, graph, graphChangedDocs);
    graphInfo.updated = true;

    // Detect broken links across the graph
    const broken = detectBrokenLinks(updated.entries, root);
    graphInfo.brokenLinks = broken.length;
    if (broken.length > 0) {
      graphInfo.brokenLinkDetails = broken.map(
        b => `${b.source}:${b.line} → ${b.target} ("${b.anchor}")`
      );
    }
  }

  // ── Write syncDocs record ─────────────────────────────────
  const next = { ...state };
  next.stage = "edit.sync_docs";
  next.syncDocs = {
    time: new Date().toISOString(),
    planHash,
    afterEditDigest: afterEdit.digest,
    implementationDigest: currentImplementationDigest,
    allowedDocs,
  };
  writeState(next);

  const displayBody: string[] = [
    "after_edit audit is current. Synchronize only the declared documentation or shared template files, then run hy_verify.",
    allowedDocs.length ? `Allowed sync files: ${allowedDocs.join(", ")}` : "No documentation sync files were declared in plan.scope.",
  ];
  if (graphInfo.updated) {
    displayBody.push(`DocsGraph incrementally updated for ${graphChangedDocs.length} changed file(s).`);
  }
  if (graphInfo.brokenLinks > 0) {
    displayBody.push(`⚠ ${graphInfo.brokenLinks} broken link(s) detected:`);
    displayBody.push(...graphInfo.brokenLinkDetails.map(d => `  - ${d}`));
  }

  return toolResult("verify", {
    phase: "edit",
    stage: "edit.sync_docs",
    status: graphInfo.brokenLinks > 0 ? "warning" : "passed",
    synced: true,
    allowedDocs,
    graphInfo,
    display: {
      title: "Document sync gate ready",
      body: displayBody.join("\n"),
      files: allowedDocs,
    },
    hint: "Use standard file editing tools only within plan.scope for documentation sync. When done, call hy_verify.",
    allowedTools: ["hy_verify", "hy_edit", "hy_status"],
    blockedTools: ["hy_commit", "hy_merge"],
    nextAction: { tool: "hy_verify", phase: "edit", stage: "verify.run", automatic: true },
    control: { automatic: true, stop: false, reason: "automatic" },
    userAction: null,
  });
}
