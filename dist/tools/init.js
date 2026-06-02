import { readState, writeState, transition, assertPhase, projectRoot } from "../state.js";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
const MARKER_START = "<!-- hy-workflow-rules -->";
const MARKER_END = "<!-- /hy-workflow-rules -->";
const WORKFLOW_INSTRUCTIONS = `
${MARKER_START}

## hy-workflow 硬性流程

你正在操作一个启用了 hy-workflow MCP 的项目。以下规则必须严格遵循：

### 流程顺序（禁止跳过或重排）

首次使用: hy_init → hy_plan → ...
后续使用: hy_status → hy_plan → hy_approve → hy_branch → hy_edit → hy_verify → hy_commit → hy_ci → hy_merge → hy_chain

### 各工具说明

**0. hy_init** — 项目首次使用时调用。部署 hy-harness。已部署则跳过，自动进 plan。

**1. hy_plan** — 调用时传入 {task, plan}。自行利用工作区上下文构造 PlanDoc JSON。服务端通过 6 道 gate 校验 PlanDoc 质量，通过后方可进入 approve。
**重要**: hy_plan 返回后，原样输出 summary 字段的内容向用户展示。禁止在用户查看前自行推进到下一步。

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

### hy_reset

hy_reset 可在任意阶段调用，重置到 plan 阶段并清空当前工作数据。仅在用户明确要求放弃当前开发任务时使用。

### hy_plan 使用

调用 hy_plan({task: "描述你要做的任务", plan: { ... PlanDoc JSON ... }})。构造 PlanDoc 时：
- 先用 Read/Glob/Grep 了解项目结构，确认每个文件路径存在
- task：描述解决的问题和动机，不是操作步骤列表
- dependency_dag：说明哪些模块受影响、哪些不受影响、依赖链方向
- entry_points：覆盖编译+lint+测试，每条对应一个验证维度
- risks：每条含场景+影响+缓解措施，不写一句话标签
- discussion：含至少一个备选方案及否定理由

### hy_plan 触发

仅在当前 phase 为 plan 且用户明确在发起开发任务时才调用 hy_plan。日常讨论、询问问题不算触发条件。
触发词包括 "计划一下"、"plan it"、"做个计划"、"做计划"、"plan this"、或用户描述开发任务意图时。

### approve 后自动推进

hy_approve 被输入 "approve" 通过后，返回结果包含 pipeline 数组和 stopAfter。
按 pipeline 顺序逐条执行到 stopAfter 为止，不可跳步或调序。
每完成一步，用简短语句向用户汇报当前进度（如"已创建分支 feat/xxx""已锁定 scope，开始编辑""验证通过，正在 commit"）。

hy_commit 创建 PR 后任务结束。用户需要时手动调用: hy_ci → hy_merge → hy_chain。

### 失败处理

hy_verify 失败: 编辑修复后重新 hy_verify。
hy_ci 有红:   编辑修复后重新 hy_verify → hy_commit → hy_ci。
hy_status 随时可查看当前阶段。

### 提示

所有工具返回均为 JSON，含 next 字段指示下一阶段。

${MARKER_END}
`;
function upsertInstructions(root) {
    const dir = path.join(root, ".opencode");
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "instructions.md");
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
export async function handleInit() {
    const state = readState();
    assertPhase(state, "init", "plan");
    try {
        execSync("npx --yes github:voxServalG/hy-harness", { stdio: "inherit", timeout: 60_000 });
    }
    catch {
        return { next: "init", error: "Harness deployment failed. Check Node.js >= 18 and Python >= 3.10." };
    }
    // Generate .opencode/instructions.md with hy-workflow rules
    const root = projectRoot();
    const instructionsChanged = upsertInstructions(root);
    const next = state.phase === "init" ? transition(state, "plan") : state;
    writeState(next);
    const verb = instructionsChanged ? "created/updated" : "up to date";
    return {
        next: "plan",
        message: `Harness deployed. .opencode/instructions.md ${verb}. Run hy_plan to define your task.`,
    };
}
//# sourceMappingURL=init.js.map