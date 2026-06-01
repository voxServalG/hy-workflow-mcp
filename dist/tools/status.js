import { readState } from "../state.js";
const PHASE_ACTIONS = {
    init: { verb: "hy_init", instructions: "Run hy_init() to deploy harness", triggerWords: ["初始化"] },
    plan: { verb: "hy_plan", instructions: "Run hy_plan({task: 'describe your task'}) to generate a plan", triggerWords: ["计划一下", "plan it", "做个计划", "做计划", "plan this"] },
    approve: { verb: "hy_approve", instructions: "User reviews plan. Pass approved='approve' to proceed, anything else to reject.", triggerWords: ["批准", "approve", "同意", "驳回", "reject"] },
    branch: { verb: "hy_branch", instructions: "Run hy_branch({category, topic}) to create a git branch", triggerWords: ["创建分支", "branch"] },
    edit: { verb: "hy_edit", instructions: "Lock scope with hy_edit(), then use Read/Edit/Write tools", triggerWords: [] },
    verify: { verb: "hy_verify", instructions: "Run hy_verify() to validate all checks", triggerWords: ["验证", "检查", "verify"] },
    commit: { verb: "hy_commit", instructions: "Run hy_commit({title, sections}) to create PR", triggerWords: ["提交", "commit"] },
    ci: { verb: "hy_ci", instructions: "Run hy_ci() to check CI status", triggerWords: ["CI", "检查状态"] },
    merge: { verb: "hy_merge", instructions: "Run hy_merge() to merge the PR", triggerWords: ["合并", "merge"] },
    chain: { verb: "hy_chain", instructions: "Run hy_chain({branches}) to rebase downstream branches", triggerWords: ["同步", "chain"] },
    done: { verb: "", instructions: "Workflow complete. Call hy_reset() to start a new task.", triggerWords: ["重置", "新任务", "reset"] },
};
export async function handleStatus() {
    const state = readState();
    const action = PHASE_ACTIONS[state.phase];
    const r = {
        phase: state.phase,
        branch: state.branch,
        prNumber: state.prNumber,
        plan: state.plan?.task ?? null,
        approved: state.approval !== null,
        verified: state.verifyHash !== null,
        next: state.phase,
        action: {
            verb: action.verb,
            instructions: action.instructions,
            triggerWords: action.triggerWords,
        },
    };
    return r;
}
//# sourceMappingURL=status.js.map