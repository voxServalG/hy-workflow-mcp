import { legacyRuntimeDiagnostics, readState, writeState, transition, assertPhase, projectRoot } from "../state.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { toolResult } from "./_base.js";
import { SETUP_COMMAND, SETUP_STAMP } from "../bootstrap.js";
const MARKER_START = "<!-- hy-workflow-rules -->";
const MARKER_END = "<!-- /hy-workflow-rules -->";
export const INIT_COMMIT_ARTIFACTS = [
    ".github/",
    "AGENTS.md",
    "codelint.json",
    "doclint.json",
    "docs-gardener.json",
];
export const INIT_LOCAL_ARTIFACTS = [
    ".hy/",
    ".opencode/",
];
export const REQUIRED_SETUP_ARTIFACTS = [
    ".github/workflows/code-quality.yml",
    ".github/workflows/docs-check.yml",
    "codelint.json",
    "doclint.json",
    "docs-gardener.json",
    SETUP_STAMP,
];
const LEGACY_HARNESS_ARTIFACTS = [
    ".github/",
    "codelint.json",
    "doclint.json",
    "docs-gardener.json",
];
const LEGACY_HARNESS_MISSING_TYPE = "harness_missing";
const WORKFLOW_INSTRUCTIONS = `
${MARKER_START}

## hy-workflow 硬性流程

你正在操作一个启用了 hy-workflow MCP 的项目。以下规则必须严格遵循：

### 流程顺序（禁止跳过或重排）

首次使用: hy_init → hy_plan → ...
后续使用: hy_status → hy_plan → hy_approve → hy_branch → hy_edit → hy_verify → hy_commit → hy_ci → hy_merge → hy_chain

### 各工具说明

**0. hy_init** — 项目首次使用时调用。验证 setup 已部署 bootstrap 产物，写入/更新 workflow 规则和本地忽略项，自动进 plan。不会在 MCP 内启动 setup 或交互式 TUI。

**1. hy_plan** — 调用时传入 {task, plan}。自行利用工作区上下文构造 PlanDoc JSON。服务端通过 6 道 gate 校验 PlanDoc 质量，通过后方可进入 approve。
**重要**: hy_plan 返回后，必须原样完整输出 summary 字段的内容向用户展示，不能摘要、压缩、改写。禁止在用户查看前自行推进到下一步。

**2. hy_approve** — 用户审视 plan。严禁在用户未明确回复批准前调用 hy_approve({approved:'approve'})。必须等待用户对展示的 plan 做出认可。犹豫时反问用户确认。

**3. hy_branch** — 创建分支，category ∈ {refactor, feat, chore, docs, ci, fix, test}。

**4. hy_edit** — 锁定 scope，用 Read/Edit/Write 编辑，禁止编辑 plan.scope 未声明的文件。

**5. hy_verify** — 全量校验: lint → compile → scope → boundary → platform → smoke → tests。失败回 hy_edit，通过进 hy_commit。

**6. hy_commit** — git add + commit + push + gh pr create。

**7. hy_ci** — 等待 CI，红色回 hy_edit，全绿进 hy_merge。

**8. hy_merge** — 合并 PR，删除远程分支。

**9. hy_chain** — rebase 下游分支。

### 禁止操作

- 直接使用 git checkout / git commit / git push / gh pr create
- 跳过 hy_verify 直接调 hy_commit
- hy_approve 驳回后自行推进
- 编辑 plan.scope 声明外的文件
- 不要提交本地或运行时目录：.hy/、.opencode/

### hy_init 初始化产物

hy_init 后通常应提交这些项目配置：.github/、AGENTS.md、codelint.json、doclint.json、docs-gardener.json。
hy_init 后不要提交这些本地或运行时文件：.hy/、.opencode/。

### 关键输出规则（优先于 openCode 默认短输出倾向）

以下规则优先于 openCode 默认的"少于 4 行""减少输出 token"等简短回复规则：

- **hy_plan summary 必须完整展示**：hy_plan 返回的 summary 字段内容必须原样、完整输出给用户审阅，不得摘要、压缩、改写或省略
- **未完整展示前禁止 approve**：在用户看到完整 summary 之前，禁止调用 hy_approve 或自动推进到下一步
- **命令字段纯 shell**：entry_points、smoke、tests 中的 command 必须是可直接执行的 shell 命令，不得写自然语言说明、括号注释或冒号描述；所有说明文字写入对应的 description 字段

### hy_reset

hy_reset 可在任意阶段调用，重置到 plan 阶段并清空当前工作数据。用于 PR 已合并且 hy_chain 完成后的正常收尾；也可在用户明确要求放弃当前开发任务时使用。

### hy_plan 使用

调用 hy_plan({task: "描述你要做的任务", plan: { ... PlanDoc JSON ... }})。构造 PlanDoc 时：
- 先用 Read/Glob/Grep 了解项目结构，确认每个文件路径存在
- task：描述解决的问题和动机，不是操作步骤列表
- dependency_dag：说明哪些模块受影响、哪些不受影响、依赖链方向
- entry_points：覆盖编译+lint+测试，每条对应一个验证维度
- entry_points、smoke.command、tests.command 必须是纯 shell 命令，命令后不得加括号说明、冒号说明或自然语言说明
- 说明文字统一写到 description 字段；PlanDoc JSON 字符串尽量避免未转义的反斜杠、反引号、引号和换行
- risks：每条含场景+影响+缓解措施，不写一句话标签
- discussion：含至少一个备选方案及否定理由

### hy_plan 触发

仅在当前 phase 为 plan 且用户明确在发起开发任务时才调用 hy_plan。日常讨论、询问问题不算触发条件。
触发词包括 "计划一下"、"plan it"、"做个计划"、"做计划"、"plan this"、或用户描述开发任务意图时。

### approve 后自动推进

hy_approve 被输入 "approve" 通过后，返回结果包含 pipeline 数组和 stopAfter。
按 pipeline 顺序逐条执行到 stopAfter 为止，不可跳步或调序。
每完成一步，用简短语句向用户汇报当前进度（如"已创建分支 feat/xxx""已锁定 scope，开始编辑""验证通过，正在 commit"）。

任务完成标准不是 hy_commit，而是 PR 合并到 baseBranch 后调用 hy_chain（无下游分支时传空数组）并 hy_reset 回到 plan。
hy_commit → hy_ci → hy_merge → hy_chain → hy_reset 中间除非工具返回 error、requires_user 或 stop_here（例如 CI 红、CI pending/API 异常、push/PR/merge/rebase 失败），否则不要停下。

### 失败处理

hy_verify 失败: 编辑修复后重新 hy_verify。
hy_ci 有红:   停下并展示结构化失败信息；编辑修复后重新 hy_verify → hy_commit → hy_ci。
hy_ci pending/API 异常: 停下并展示结构化状态；不要进入 edit，等待后重试 hy_ci。
hy_status 随时可查看当前阶段。

### 提示

所有工具返回均为 JSON，含 next 字段指示下一阶段。

${MARKER_END}
`;
function upsertInstructions(root) {
    const filePath = path.join(root, "AGENTS.md");
    let existing = "";
    let changed = false;
    if (fs.existsSync(filePath)) {
        existing = fs.readFileSync(filePath, "utf-8");
        const startIdx = existing.indexOf(MARKER_START);
        const endIdx = existing.indexOf(MARKER_END);
        if (startIdx !== -1 && endIdx !== -1) {
            const before = existing.substring(0, startIdx);
            const after = existing.substring(endIdx + MARKER_END.length);
            const updated = before + WORKFLOW_INSTRUCTIONS.trim() + "\n" + after;
            if (updated !== existing) {
                fs.writeFileSync(filePath, updated, "utf-8");
                changed = true;
            }
        }
        else {
            const append = existing.endsWith("\n") ? WORKFLOW_INSTRUCTIONS.trim() + "\n" : "\n" + WORKFLOW_INSTRUCTIONS.trim() + "\n";
            fs.writeFileSync(filePath, existing + append, "utf-8");
            changed = true;
        }
    }
    else {
        fs.writeFileSync(filePath, WORKFLOW_INSTRUCTIONS.trim() + "\n", "utf-8");
        changed = true;
    }
    return changed;
}
function cleanupOldPath(root) {
    const oldPath = path.join(root, ".opencode", "instructions.md");
    if (!fs.existsSync(oldPath))
        return;
    const content = fs.readFileSync(oldPath, "utf-8");
    const startIdx = content.indexOf(MARKER_START);
    const endIdx = content.indexOf(MARKER_END);
    if (startIdx === -1 || endIdx === -1)
        return;
    const before = content.substring(0, startIdx).trimEnd();
    const after = content.substring(endIdx + MARKER_END.length);
    const cleaned = (before + after).trim();
    if (cleaned) {
        fs.writeFileSync(oldPath, cleaned + "\n", "utf-8");
    }
    else {
        fs.unlinkSync(oldPath);
    }
}
export function ensureLocalArtifactIgnores(root) {
    const filePath = path.join(root, ".gitignore");
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
    const lines = existing.split(/\r?\n/).filter(line => line.length > 0);
    const missing = INIT_LOCAL_ARTIFACTS.filter(item => !lines.includes(item));
    if (!missing.length)
        return false;
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(filePath, `${existing}${prefix}${missing.join("\n")}\n`, "utf-8");
    return true;
}
export function initArtifactGuidance() {
    return {
        commitArtifacts: [...INIT_COMMIT_ARTIFACTS],
        localArtifacts: [...INIT_LOCAL_ARTIFACTS],
        body: [
            "Commit project artifacts:",
            ...INIT_COMMIT_ARTIFACTS.map(item => `- ${item}`),
            "",
            "Do not commit local/runtime artifacts:",
            ...INIT_LOCAL_ARTIFACTS.map(item => `- ${item}`),
        ].join("\n"),
    };
}
function artifactExists(root, artifact) {
    const artifactPath = path.join(root, artifact.replace(/\/$/, ""));
    return fs.existsSync(artifactPath);
}
export function setupArtifactStatus(root) {
    const missingArtifacts = REQUIRED_SETUP_ARTIFACTS.filter(item => !artifactExists(root, item));
    return {
        requiredArtifacts: [...REQUIRED_SETUP_ARTIFACTS],
        missingArtifacts,
        ready: missingArtifacts.length === 0,
    };
}
export function harnessArtifactStatus(root) {
    const missingArtifacts = LEGACY_HARNESS_ARTIFACTS.filter(item => !artifactExists(root, item));
    return {
        requiredArtifacts: [...LEGACY_HARNESS_ARTIFACTS],
        missingArtifacts,
        ready: missingArtifacts.length === 0,
    };
}
function setupMissingResult(missingArtifacts) {
    const instruction = `Run the project setup script from a terminal, then restart the agent/MCP session and rerun hy_init: ${SETUP_COMMAND}`;
    return toolResult("init", {
        error: {
            type: "setup_artifacts_missing",
            legacyType: LEGACY_HARNESS_MISSING_TYPE,
            message: "Required setup/bootstrap artifacts are missing. hy_init is non-interactive and will not run setup inside MCP.",
            missingArtifacts,
        },
        display: {
            title: "Setup required",
            body: [
                "hy_init did not find the required setup/bootstrap artifacts:",
                ...missingArtifacts.map(item => `- ${item}`),
                "",
                instruction,
            ].join("\n"),
        },
        hint: "Stop and ask the user to run setup in a terminal and restart the agent. Do not call hy_plan until hy_init succeeds.",
        requires_user: true,
        stop_here: true,
        allowedTools: ["hy_init", "hy_status"],
        blockedTools: ["hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"],
        recovery: { tool: "hy_init", instruction },
        missingArtifacts,
    });
}
export async function handleInit() {
    const state = readState();
    assertPhase(state, "init", "plan");
    const root = projectRoot();
    const setupStatus = setupArtifactStatus(root);
    if (!setupStatus.ready)
        return setupMissingResult(setupStatus.missingArtifacts);
    const instructionsChanged = upsertInstructions(root);
    cleanupOldPath(root);
    const gitignoreChanged = ensureLocalArtifactIgnores(root);
    const next = state.phase === "init" ? transition(state, "plan") : state;
    writeState(next);
    const verb = instructionsChanged ? "created/updated" : "up to date";
    const legacyDiagnostics = legacyRuntimeDiagnostics(root);
    const artifactGuidance = initArtifactGuidance();
    const legacyHint = legacyDiagnostics.length
        ? ` Legacy runtime files need manual cleanup: ${legacyDiagnostics.map(d => d.remediation ?? d.message).join(" ")}`
        : "";
    return toolResult("plan", {
        display: {
            title: "Setup ready",
            body: `Setup/bootstrap artifacts verified. AGENTS.md ${verb}. .gitignore ${gitignoreChanged ? "updated" : "up to date"}.\n\n${artifactGuidance.body}${legacyHint}`,
        },
        hint: `Commit only commitArtifacts unless the user explicitly requests local config. Do not commit localArtifacts. Call hy_plan next only when the user has a concrete repository change task.${legacyHint}`,
        allowedTools: ["hy_plan", "hy_status"],
        commitArtifacts: artifactGuidance.commitArtifacts,
        localArtifacts: artifactGuidance.localArtifacts,
        requiredSetupArtifacts: setupStatus.requiredArtifacts,
        gitignoreChanged,
        legacyDiagnostics: legacyDiagnostics.length ? legacyDiagnostics : undefined,
        message: `Setup/bootstrap artifacts verified. AGENTS.md ${verb}. Run hy_plan to define your task.`,
    });
}
//# sourceMappingURL=init.js.map