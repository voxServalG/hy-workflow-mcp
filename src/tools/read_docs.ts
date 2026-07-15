import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  assertPhase,
  computePlanHash,
  projectRoot,
  readState,
  writeState,
  type DocumentReadFile,
  type DocumentReadSnapshot,
  type DocumentReadStage,
  type DocsGraph,
} from "../state.js";
import {
  ensureGraph,
  traverseByTask,
  buildDocsGraph,
  loadDocsGraph,
} from "../docs_graph.js";
import { buildImplementationManifest } from "../checks.js";
import { implementationDigest, implementationFilesForDigest } from "./sync_docs.js";
import { toolResult, type ToolResult } from "./_base.js";
import { resolveDocsDir } from "../docs_paths.js";
import { readUnifiedConfig } from "../config.js";

function sha256(value: string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex");
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 12);
}

function readDocsDir(root: string): string {
  const docsDir = readUnifiedConfig(root)?.project?.docsDir;
  return typeof docsDir === "string" && docsDir.trim() ? docsDir : "docs";
}

function buildFindings(
  stage: DocumentReadStage,
  files: DocumentReadFile[],
  task: string,
  planHash: string | null,
  graph: DocsGraph,
  traversalRoots: string[]
): string[] {
  const fileList = traversalRoots.join(", ") || "none";
  const graphInfo = `Graph digest: ${graph.digest}, entries: ${Object.keys(graph.entries).length}, entry points: ${graph.entryPoints.join(", ")}`;

  if (stage === "before_plan") {
    return [
      "Purpose: establish a planning fact baseline before writing PlanDoc.",
      `Task to ground: ${task}`,
      `Graph-driven traversal: ${graphInfo}`,
      `Documents traversed (${traversalRoots.length}): ${fileList}`,
      "Agent obligation: use these documented facts to identify constraints, terminology, existing workflow rules, relevant files, unknowns, and verification expectations before calling hy_plan.",
    ];
  }
  if (stage === "before_approve") {
    return [
      "Purpose: audit the already generated PlanDoc before calling hy_approve.",
      `Plan hash audited: ${planHash ?? "none"}`,
      `Graph-driven traversal: ${graphInfo}`,
      `Documents traversed (${traversalRoots.length}): ${fileList}`,
      "Agent obligation: compare PlanDoc task, scope, boundary, verification, risks, and discussion against these documents; if facts drift, scope is missing, verification is weak, or risks are incomplete, reject the plan and call hy_plan again instead of approving.",
    ];
  }
  return [
    "Purpose: audit implementation diff against documentation before final verification.",
    `Plan hash audited: ${planHash ?? "none"}`,
    `Graph-driven traversal: ${graphInfo}`,
    `Documents traversed (${traversalRoots.length}): ${fileList}`,
    "Agent obligation: compare the implementation diff with documentation, then call hy_sync_docs before hy_verify so documentation changes are included in final lint and tests.",
  ];
}

function buildSnapshot(
  stage: DocumentReadStage,
  task: string,
  planHash: string | null
): DocumentReadSnapshot | ToolResult {
  const root = projectRoot();
  const configuredDocsDir = readDocsDir(root);
  const resolvedDocsDir = resolveDocsDir(root, configuredDocsDir);
  if (!resolvedDocsDir.ok) {
    return toolResult(stage === "before_plan" ? "plan" : "approve", {
      error: `Invalid project.docsDir: ${resolvedDocsDir.error}`,
      hint: "Update hy-workflow.json project.docsDir to a project-relative directory inside the repository.",
      allowedTools: ["hy_status"],
    });
  }
  const { docsDir, docsRoot } = resolvedDocsDir;

  if (!fs.existsSync(docsRoot) || !fs.statSync(docsRoot).isDirectory()) {
    return toolResult(stage === "before_plan" ? "plan" : "approve", {
      error: `Configured docsDir does not exist or is not a directory: ${docsDir}`,
      hint: "Create the configured docs directory or update hy-workflow.json project.docsDir before continuing.",
      allowedTools: ["hy_status"],
    });
  }

  // Ensure graph is current (build or reload)
  const graph = ensureGraph(root, docsDir);
  const docsGraphDigest = graph.digest;

  // Run task-driven traversal
  const extraEntryPoints: string[] = [];
  // Always include README.md and AGENTS.md as supplemental entry points
  const readmePath = path.join(docsDir, "README.md").split(path.sep).join("/");
  const agentsPath = "AGENTS.md";
  if (fs.existsSync(path.join(root, readmePath))) extraEntryPoints.push(readmePath);
  if (fs.existsSync(path.join(root, agentsPath))) extraEntryPoints.push(agentsPath);

  const traversal = traverseByTask(root, graph, task, extraEntryPoints);

  // Read traversed files
  const files: DocumentReadFile[] = traversal.read.map(rel => {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) return null;
    const raw = fs.readFileSync(full, "utf-8");
    return {
      path: rel,
      bytes: Buffer.byteLength(raw, "utf-8"),
      sha256: sha256(raw),
      content: raw,
      truncated: false, // no truncation — we only read matched docs
    };
  }).filter(Boolean) as DocumentReadFile[];

  // Fallback: no files matched via traversal? Use entry points directly
  if (files.length === 0) {
    for (const ep of graph.entryPoints) {
      const full = path.join(root, ep);
      if (fs.existsSync(full)) {
        const raw = fs.readFileSync(full, "utf-8");
        files.push({
          path: ep,
          bytes: Buffer.byteLength(raw, "utf-8"),
          sha256: sha256(raw),
          content: raw,
          truncated: false,
        });
      }
    }
  }

  const findings = buildFindings(stage, files, task, planHash, graph, traversal.read);
  return {
    stage,
    purpose: stage === "before_plan"
      ? "Establish planning fact baseline before PlanDoc creation."
      : stage === "before_approve"
        ? "Audit the concrete PlanDoc against docs before approval."
        : "Audit implementation diff against docs before final verification.",
    time: new Date().toISOString(),
    task,
    planHash,
    docsDir,
    digest: shortHash(JSON.stringify(files.map(f => ({ path: f.path, sha256: f.sha256 })))),
    files,
    findings,
    docsGraphDigest,
    entryPoints: traversal.entryPoints,
    traversalRoots: traversal.read,
  };
}

export async function handleReadDocs(args: { stage?: DocumentReadStage; task?: string }): Promise<ToolResult> {
  const state = readState();
  const stage = args.stage;

  if (stage !== "before_plan" && stage !== "before_approve" && stage !== "after_edit") {
    return toolResult(state.phase, {
      error: "stage must be before_plan, before_approve, or after_edit.",
      hint: "Call hy_read_docs with { stage: \"before_plan\", task }, { stage: \"before_approve\" }, or { stage: \"after_edit\" } at the matching workflow point.",
      allowedTools: ["hy_read_docs", "hy_status"],
    });
  }

  if (stage === "before_plan") {
    assertPhase(state, "plan");
    const task = (args.task ?? "").trim();
    if (!task) {
      return toolResult("plan", {
        error: "task is required for before_plan document reading.",
        hint: "Pass the user task so the document baseline can be tied to the future PlanDoc.",
        allowedTools: ["hy_read_docs", "hy_status"],
      });
    }
    const snapshot = buildSnapshot(stage, task, null);
    if ("next" in snapshot) return snapshot;
    const next = {
      ...state,
      documentReads: {
        ...(state.documentReads ?? {}),
        beforePlan: snapshot,
        beforeApprove: null,
      },
    };
    writeState(next);
    return toolResult("plan", {
      stage,
      snapshot,
      display: {
        title: "Document baseline ready",
        body: snapshot.findings.join("\n"),
        files: snapshot.files.map(f => f.path),
      },
      hint: "Use the document baseline to construct PlanDoc, then call hy_plan. This is not a user review gate.",
      allowedTools: ["hy_plan", "hy_status"],
    });
  }

  if (stage === "after_edit") {
    assertPhase(state, "edit", "verify");
    const planHash = computePlanHash(state.plan);
    if (!state.plan || !planHash) {
      return toolResult("edit", {
        phase: state.phase,
        error: "after_edit document reading requires an existing PlanDoc.",
        hint: "Call hy_plan and hy_edit before hy_read_docs with stage after_edit.",
        allowedTools: ["hy_status"],
      });
    }
    const snapshot = buildSnapshot(stage, state.plan.task, planHash);
    if ("next" in snapshot) return snapshot;
    const manifest = buildImplementationManifest(projectRoot());
    const auditedSnapshot: DocumentReadSnapshot = {
      ...snapshot,
      implementationFiles: implementationFilesForDigest(state.plan, manifest),
      implementationDigest: implementationDigest(projectRoot(), state.plan, manifest),
    };
    writeState({
      ...state,
      documentReads: {
        ...(state.documentReads ?? {}),
        afterEdit: auditedSnapshot,
      },
      syncDocs: null,
    });
    return toolResult("edit", {
      phase: state.phase,
      stage,
      snapshot: auditedSnapshot,
      display: {
        title: "Implementation document audit ready",
        body: auditedSnapshot.findings.join("\n"),
        files: auditedSnapshot.files.map(f => f.path),
      },
      hint: "Use this after_edit audit to identify documentation or shared template updates, then call hy_sync_docs before hy_verify.",
      allowedTools: ["hy_sync_docs", "hy_edit", "hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"],
    });
  }

  assertPhase(state, "approve");
  const planHash = computePlanHash(state.plan);
  if (!state.plan || !planHash) {
    return toolResult("approve", {
      error: "before_approve document reading requires an existing PlanDoc.",
      hint: "Call hy_plan first, then hy_read_docs with stage before_approve.",
      allowedTools: ["hy_status"],
    });
  }

  const snapshot = buildSnapshot(stage, state.plan.task, planHash);
  if ("next" in snapshot) return snapshot;
  const beforePlan = state.documentReads?.beforePlan ?? null;
  const changedSinceBaseline = Boolean(beforePlan && (beforePlan.digest !== snapshot.digest || beforePlan.docsGraphDigest !== snapshot.docsGraphDigest));
  const findings = changedSinceBaseline
    ? [...snapshot.findings, "Document digest or DocsGraph digest changed since before_plan; agent must reject and re-plan if the changed documents affect the PlanDoc."]
    : snapshot.findings;
  const auditedSnapshot: DocumentReadSnapshot = { ...snapshot, changedSinceBaseline, findings };
  writeState({
    ...state,
    documentReads: {
      ...(state.documentReads ?? {}),
      beforeApprove: auditedSnapshot,
    },
  });

  return toolResult("approve", {
    stage,
    snapshot: auditedSnapshot,
    changedSinceBaseline,
    display: {
      title: "Plan document audit ready",
      body: auditedSnapshot.findings.join("\n"),
      files: auditedSnapshot.files.map(f => f.path),
    },
    hint: "Use this audit to decide whether the PlanDoc is still valid. If valid, call hy_approve with the user's existing approval. This is not a separate user review gate.",
    allowedTools: ["hy_approve", "hy_status"],
  });
}
