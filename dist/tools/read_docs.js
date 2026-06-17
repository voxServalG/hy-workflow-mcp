import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { assertPhase, computePlanHash, projectRoot, readState, writeState, } from "../state.js";
import { toolResult } from "./_base.js";
const MAX_FILE_CHARS = 6000;
const READABLE_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst"]);
function sha256(value) {
    const hash = createHash("sha256");
    hash.update(value);
    return hash.digest("hex");
}
function shortHash(value) {
    return sha256(value).slice(0, 12);
}
function readDocsDir(root) {
    const configPath = path.join(root, "hy-workflow.json");
    if (!fs.existsSync(configPath))
        return "docs";
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const docsDir = config?.project?.docsDir;
        return typeof docsDir === "string" && docsDir.trim() ? docsDir : "docs";
    }
    catch {
        return "docs";
    }
}
function listDocumentFiles(root, docsDir) {
    const docsRoot = path.join(root, docsDir);
    const files = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.name.startsWith("."))
                continue;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!READABLE_EXTENSIONS.has(path.extname(entry.name)))
                continue;
            files.push(path.relative(root, full).split(path.sep).join("/"));
        }
    };
    walk(docsRoot);
    return files.sort();
}
function readDocumentFiles(root, docsDir) {
    return listDocumentFiles(root, docsDir).map(rel => {
        const full = path.join(root, rel);
        const raw = fs.readFileSync(full, "utf-8");
        return {
            path: rel,
            bytes: Buffer.byteLength(raw, "utf-8"),
            sha256: sha256(raw),
            content: raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) : raw,
            truncated: raw.length > MAX_FILE_CHARS,
        };
    });
}
function buildFindings(stage, files, task, planHash) {
    const fileList = files.map(f => f.path).join(", ") || "none";
    if (stage === "before_plan") {
        return [
            "Purpose: establish a planning fact baseline before writing PlanDoc.",
            `Task to ground: ${task}`,
            `Documents read: ${fileList}`,
            "Agent obligation: use these documented facts to identify constraints, terminology, existing workflow rules, relevant files, unknowns, and verification expectations before calling hy_plan.",
        ];
    }
    return [
        "Purpose: audit the already generated PlanDoc before calling hy_approve.",
        `Plan hash audited: ${planHash ?? "none"}`,
        `Documents read: ${fileList}`,
        "Agent obligation: compare PlanDoc task, scope, boundary, verification, risks, and discussion against these documents; if facts drift, scope is missing, verification is weak, or risks are incomplete, reject the plan and call hy_plan again instead of approving.",
    ];
}
function buildSnapshot(stage, task, planHash) {
    const root = projectRoot();
    const docsDir = readDocsDir(root);
    const docsRoot = path.join(root, docsDir);
    if (!fs.existsSync(docsRoot) || !fs.statSync(docsRoot).isDirectory()) {
        return toolResult(stage === "before_plan" ? "plan" : "approve", {
            error: `Configured docsDir does not exist or is not a directory: ${docsDir}`,
            hint: "Create the configured docs directory or update hy-workflow.json project.docsDir before continuing.",
            allowedTools: ["hy_status"],
        });
    }
    const files = readDocumentFiles(root, docsDir);
    if (!files.length) {
        return toolResult(stage === "before_plan" ? "plan" : "approve", {
            error: `No readable documentation files found in ${docsDir}. Expected .md, .mdx, .txt, or .rst files.`,
            hint: "Add project documentation or update hy-workflow.json project.docsDir before continuing.",
            allowedTools: ["hy_status"],
        });
    }
    const digest = shortHash(JSON.stringify(files.map(f => ({ path: f.path, sha256: f.sha256 }))));
    return {
        stage,
        purpose: stage === "before_plan"
            ? "Establish planning fact baseline before PlanDoc creation."
            : "Audit the concrete PlanDoc against docs before approval.",
        time: new Date().toISOString(),
        task,
        planHash,
        docsDir,
        digest,
        files,
        findings: buildFindings(stage, files, task, planHash),
    };
}
export async function handleReadDocs(args) {
    const state = readState();
    const stage = args.stage;
    if (stage !== "before_plan" && stage !== "before_approve") {
        return toolResult(state.phase, {
            error: "stage must be either before_plan or before_approve.",
            hint: "Call hy_read_docs with { stage: \"before_plan\", task } before hy_plan, or { stage: \"before_approve\" } before hy_approve.",
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
        if ("next" in snapshot)
            return snapshot;
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
    if ("next" in snapshot)
        return snapshot;
    const beforePlan = state.documentReads?.beforePlan ?? null;
    const changedSinceBaseline = beforePlan && beforePlan.digest !== snapshot.digest;
    const findings = changedSinceBaseline
        ? [...snapshot.findings, "Document digest changed since before_plan; agent must reject and re-plan if the changed documents affect the PlanDoc."]
        : snapshot.findings;
    const auditedSnapshot = { ...snapshot, findings };
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
//# sourceMappingURL=read_docs.js.map