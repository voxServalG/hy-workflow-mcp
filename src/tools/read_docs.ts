import * as fs from "node:fs";
import * as path from "node:path";
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
} from "../docs_graph.js";
import { buildImplementationManifest } from "../checks.js";
import { implementationDigest, implementationFilesForDigest } from "./sync_docs.js";
import { toolResult, type ToolResult } from "./_base.js";
import { resolveDocsDir } from "../docs_paths.js";
import { requireRuntimeConfig } from "../config.js";
import { inspectDocumentation, selectDocumentPage } from "../policy/docs.js";
import { isRuntimeIgnoredArtifact } from "../policy/artifacts.js";

function readDocsDir(root: string): string {
  return requireRuntimeConfig(root).project.docsDir as string;
}

function documentReadPhase(stage: DocumentReadStage): "plan" | "approve" | "edit" {
  if (stage === "before_plan") return "plan";
  if (stage === "before_approve") return "approve";
  return "edit";
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
  planHash: string | null,
  cursor?: string,
): DocumentReadSnapshot | ToolResult {
  const root = projectRoot();
  const nextPhase = documentReadPhase(stage);
  let configuredDocsDir: string;
  try {
    configuredDocsDir = readDocsDir(root);
  } catch (error) {
    return toolResult(nextPhase, {
      error,
      hint: "Run hy-workflow setup in the project root, then retry hy_read_docs.",
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_status"],
    });
  }
  if (isRuntimeIgnoredArtifact(root, configuredDocsDir)) {
    return toolResult(nextPhase, {
      error: "Configured project.docsDir points to an ignored legacy or runtime path.",
      hint: "Choose a maintained documentation directory outside legacy injection and runtime paths.",
      allowedTools: ["hy_status"],
    });
  }
  const resolvedDocsDir = resolveDocsDir(root, configuredDocsDir);
  if (!resolvedDocsDir.ok) {
    return toolResult(nextPhase, {
      error: `Invalid project.docsDir: ${resolvedDocsDir.error}`,
      hint: "Update project.docsDir in the authoritative project configuration to a project-relative directory inside the repository.",
      allowedTools: ["hy_status"],
    });
  }
  const { docsDir, docsRoot } = resolvedDocsDir;

  if (!fs.existsSync(docsRoot) || !fs.statSync(docsRoot).isDirectory()) {
    return toolResult(nextPhase, {
      error: `Configured docsDir does not exist or is not a directory: ${docsDir}`,
      hint: "Create the configured docs directory or update project.docsDir in the authoritative project configuration before continuing.",
      allowedTools: ["hy_status"],
    });
  }

  // Ensure graph is current (build or reload)
  const graph = ensureGraph(root, docsDir);
  const docsGraphDigest = graph.digest;

  const graphFiles = Object.keys(graph.entries);
  const docsInspection = inspectDocumentation(root, graphFiles, { includeAgents: false });
  // Root AGENTS.md may be a tracked legacy injection. The upgraded runtime
  // deliberately ignores it rather than reading, hashing, validating, or
  // migrating it. Project facts come only from the configured docs graph.
  const blockingIssue = docsInspection.issues
    .find(issue => issue.code === "DOCS_EMPTY" || issue.code === "DOCS_NO_FACTS");
  if (blockingIssue) {
    return toolResult(nextPhase, {
      error: {
        type: "docs",
        subtype: "docs_missing",
        code: blockingIssue.code,
        message: blockingIssue.message,
        detail: { docsDir, file: blockingIssue.file ?? null },
        retryable: false,
      },
      display: { title: "Documentation facts required", body: `${blockingIssue.message}\n\n${blockingIssue.recovery}` },
      hint: blockingIssue.recovery,
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_read_docs", "hy_status"],
    });
  }

  // Run task-driven traversal
  const extraEntryPoints: string[] = [];
  // Include configured root README/index variants as supplemental entry points.
  for (const entry of fs.readdirSync(docsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(readme|index)\.(md|mdx|rst|txt)$/i.test(entry.name)) continue;
    extraEntryPoints.push(path.relative(root, path.join(docsRoot, entry.name)).split(path.sep).join("/"));
  }

  const traversal = traverseByTask(root, graph, task, extraEntryPoints);
  const candidates = [...new Set([...traversal.read, ...graph.entryPoints, ...graphFiles, ...extraEntryPoints])];
  let page;
  try {
    page = selectDocumentPage(root, candidates, task, [...graph.entryPoints, ...extraEntryPoints], graph.digest, cursor);
  } catch (error: any) {
    return toolResult(nextPhase, {
      error: { type: "docs", subtype: "docs_stale", code: "DOCS_CURSOR_INVALID", message: error?.message ?? String(error), retryable: true },
      hint: "Discard the stale cursor and restart hy_read_docs without a cursor so facts are read from the current DocsGraph.",
      requires_user: false,
      stop_here: true,
      allowedTools: ["hy_read_docs", "hy_status"],
    });
  }
  const files: DocumentReadFile[] = page.files;
  if (!files.length) {
    return toolResult(nextPhase, {
      error: { type: "docs", subtype: "docs_missing", code: "DOCS_NO_FACTS", message: "No relevant substantive document facts fit the configured read policy.", retryable: false },
      hint: "Add a maintained README/index and task-relevant documentation before planning.",
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_read_docs", "hy_status"],
    });
  }

  const traversalRoots = files.map(file => file.path);
  const findings = [
    ...buildFindings(stage, files, task, planHash, graph, traversalRoots),
    `Document budget: ${page.budget.selectedFiles}/${page.budget.maxFiles} files, ${page.budget.selectedChars}/${page.budget.maxChars} chars, estimated ${page.budget.estimatedTokens}/${page.budget.estimatedMaxTokens} tokens.`,
    ...(page.pagination.hasMore ? [`More relevant documents are available; continue with cursor ${page.pagination.nextCursor}.`] : []),
  ];
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
    digest: graph.digest,
    files,
    findings,
    docsGraphDigest,
    entryPoints: traversal.entryPoints,
    traversalRoots,
    budget: page.budget,
    pagination: page.pagination,
  };
}

function withoutDocumentContents(snapshot: DocumentReadSnapshot): DocumentReadSnapshot {
  return {
    ...snapshot,
    files: snapshot.files.map(file => {
      const { content: _content, ...metadata } = file;
      return metadata;
    }),
  };
}

export async function handleReadDocs(args: { stage?: DocumentReadStage; task?: string; cursor?: string }): Promise<ToolResult> {
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
    const snapshot = buildSnapshot(stage, task, null, args.cursor);
    if ("next" in snapshot) return snapshot;
    const next = {
      ...state,
      stage,
      documentReads: {
        ...(state.documentReads ?? {}),
        beforePlan: withoutDocumentContents(snapshot),
        beforeApprove: null,
      },
    };
    writeState(next);
    return toolResult("plan", {
      stage,
      status: "passed",
      snapshot,
      display: {
        title: "Document baseline ready",
        body: snapshot.findings.join("\n"),
        files: snapshot.files.map(f => f.path),
      },
      hint: "Use the document baseline to construct PlanDoc, then call hy_plan. This is not a user review gate.",
      allowedTools: ["hy_plan", "hy_status"],
      nextAction: { tool: "hy_plan", phase: "plan", stage: "plan.compose", automatic: true },
      control: { automatic: true, stop: false, reason: "automatic" },
      userAction: null,
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
    const snapshot = buildSnapshot(stage, state.plan.task, planHash, args.cursor);
    if ("next" in snapshot) return snapshot;
    const manifest = buildImplementationManifest(projectRoot());
    const auditedSnapshot: DocumentReadSnapshot = {
      ...snapshot,
      implementationFiles: implementationFilesForDigest(state.plan, manifest),
      implementationDigest: implementationDigest(projectRoot(), state.plan, manifest),
    };
    writeState({
      ...state,
      stage,
      documentReads: {
        ...(state.documentReads ?? {}),
        afterEdit: withoutDocumentContents(auditedSnapshot),
      },
      syncDocs: null,
    });
    return toolResult("edit", {
      phase: state.phase,
      stage,
      status: "passed",
      snapshot: auditedSnapshot,
      display: {
        title: "Implementation document audit ready",
        body: auditedSnapshot.findings.join("\n"),
        files: auditedSnapshot.files.map(f => f.path),
      },
      hint: "Use this after_edit audit to identify documentation or shared template updates, then call hy_sync_docs before hy_verify.",
      allowedTools: ["hy_sync_docs", "hy_edit", "hy_status"],
      blockedTools: ["hy_verify", "hy_commit", "hy_merge"],
      nextAction: { tool: "hy_sync_docs", phase: "edit", stage: "edit.sync_docs", automatic: true },
      control: { automatic: true, stop: false, reason: "automatic" },
      userAction: null,
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

  const snapshot = buildSnapshot(stage, state.plan.task, planHash, args.cursor);
  if ("next" in snapshot) return snapshot;
  const beforePlan = state.documentReads?.beforePlan ?? null;
  const changedSinceBaseline = Boolean(beforePlan && (beforePlan.digest !== snapshot.digest || beforePlan.docsGraphDigest !== snapshot.docsGraphDigest));
  const findings = changedSinceBaseline
    ? [...snapshot.findings, "Document digest or DocsGraph digest changed since before_plan; agent must reject and re-plan if the changed documents affect the PlanDoc."]
    : snapshot.findings;
  const auditedSnapshot: DocumentReadSnapshot = { ...snapshot, changedSinceBaseline, findings };
  writeState({
    ...state,
    stage,
    documentReads: {
      ...(state.documentReads ?? {}),
      beforeApprove: withoutDocumentContents(auditedSnapshot),
    },
  });

  return toolResult("approve", {
    stage,
    status: changedSinceBaseline ? "warning" : "passed",
    snapshot: auditedSnapshot,
    changedSinceBaseline,
    display: {
      title: "Plan document audit ready",
      body: auditedSnapshot.findings.join("\n"),
      files: auditedSnapshot.files.map(f => f.path),
    },
    hint: "Use this audit to decide whether the PlanDoc is still valid. If valid, call hy_approve with the user's existing approval. This is not a separate user review gate.",
    allowedTools: ["hy_approve", "hy_status"],
    nextAction: { tool: "hy_approve", phase: "approve", stage: "approve.decision", automatic: true },
    control: { automatic: true, stop: false, reason: "automatic" },
    userAction: null,
  });
}
