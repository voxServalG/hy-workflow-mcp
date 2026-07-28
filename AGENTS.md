<!-- hy-workflow-rules -->
<!-- hy-workflow-rules-version: 2026.07.16.1 -->

## hy-workflow 硬性流程

### 统一配置源头

根目录 `hy-workflow.json` 是团队人工维护的统一配置源。共享字段放在 `project`：`baseBranch`、`codeExt`、`codeDirs`、`docsDir`。

doclint 与 codelint 是 `hy-workflow` 内置、离线、第一方规则。旧 `codelint.json`、`doclint.json`、`docs-gardener.json` 仅作为 setup/config 的只读迁移或漂移输入；运行时和 CI 不生成、不改写这些文件，也不把它们作为配置源或提交产物。

setup 固定维护团队产物：根目录 `hy-workflow.json`、`.github/workflows/hy-workflow.yml`，以及 `AGENTS.md` 中 `<!-- hy-workflow-rules -->` 与 `<!-- /hy-workflow-rules -->` 之间的托管指令块（块外内容团队所有，setup 只迁移块内版本）。不再提供部署模式选择。`unset` 只解除本机部署，不删除 `hy-workflow.json`、workflow 或 `AGENTS.md` 文件本身；`hy_init` 只验证共享配置并初始化外置状态，不改工作树或 `.git`。

不应提交的 local/runtime/client/compat artifacts：.hy/、.opencode/、.codex/、.mcp.json、codelint.json、doclint.json、docs-gardener.json、MCP 客户端本地配置。

你正在操作一个启用了 hy-workflow MCP 的项目。以下规则必须严格遵循：

### 流程顺序（禁止跳过或重排）

首次使用: hy_init → hy_read_docs(before_plan) → hy_plan → ...
后续使用: hy_status → hy_read_docs(before_plan) → hy_plan → hy_read_docs(before_approve) → hy_approve → hy_branch → hy_edit → hy_read_docs(after_edit) → hy_sync_docs → hy_verify → hy_commit → hy_ci → hy_merge → hy_chain → hy_reset

### 各工具说明

**0. hy_init** — 项目首次使用时调用。验证用户目录中的 deployment 与根目录 `hy-workflow.json`，并初始化外置状态；不写项目或 .git，自动进 plan。不会在 MCP 内启动 setup TUI。

**1. hy_read_docs(before_plan)** — 在 hy_plan 前由 agent 自动调用，不需要人类审核。读取 hy-workflow.json project.docsDir 指向的文档系统，形成规划事实基线，用于发现约束、术语、相关文件、未知点和验证期望。

**2. hy_plan** — 调用时传入 {task, plan}。自行利用 before_plan 文档事实基线和工作区上下文构造 PlanDoc JSON。服务端通过 gate 校验 PlanDoc 质量，通过后方可进入 approve。
**重要**: hy_plan 返回后，必须原样完整输出 summary 字段的内容向用户展示，不能摘要、压缩、改写。禁止在用户查看前自行推进到下一步。

**3. hy_read_docs(before_approve)** — 在用户明确批准 PlanDoc 后、调用 hy_approve 前由 agent 自动调用，不需要人类审核。读取文档系统并对当前 PlanDoc 做 agent 侧事实对齐审计；若发现事实偏移、scope 漏项、验证不足或风险缺失，必须回到 hy_plan。

**4. hy_approve** — 用户审视 plan。严禁在用户未明确回复批准前调用 hy_approve({approved:'approve'})。必须等待用户对展示的 plan 做出认可。收到用户批准后，先自动调用 hy_read_docs({stage:'before_approve'})，再调用 hy_approve；before_approve 不是新增人类审核 gate。犹豫时反问用户确认。

**5. hy_branch** — 创建分支，category ∈ {refactor, feat, chore, docs, ci, fix, test}。

**6. hy_edit** — 锁定 scope，用 Read/Edit/Write 编辑，禁止编辑 plan.scope 未声明的文件。

**7. hy_read_docs(after_edit)** — 实现编辑后由 agent 自动调用，审计实现 diff 与文档是否需要同步；不新增人类审核。

**8. hy_sync_docs** — 根据 after_edit 审计确认文档同步 gate，只允许在 plan.scope 声明的文档或团队 workflow/template 文件内同步。

**9. hy_verify** — 本地任务 gate: compile → scope → boundary → platform → smoke → tests。setup 部署的 GitHub Actions workflow 必须在原生 CI 后执行内置 doclint 与 codelint；hy_verify 失败回 hy_edit，通过进 hy_commit。

**10. hy_commit** — git add + commit + push + gh pr create。

**11. hy_ci** — 等待 CI，红色回 hy_edit，全绿进 hy_merge。没有 checks 或只有 skipped/neutral checks 时 fail closed，保持在 CI，不得进入 merge。

**12. hy_merge** — 合并 PR，删除远程分支。

**13. hy_chain** — rebase 下游分支。

**14. hy_reset** — PR 合并并完成 hy_chain 后清理当前 workflow 派生状态，回到 plan。

### 禁止操作

- 直接使用 git checkout / git commit / git push / gh pr create
- 跳过 hy_verify 直接调 hy_commit
- hy_approve 驳回后自行推进
- 编辑 plan.scope 声明外的文件
- 不要提交本地或运行时目录：.hy/、.opencode/、.codex/、.mcp.json

### hy_init 初始化产物

hy_init 的 `commitArtifacts` 为空，projectFilesChanged 为空。根配置由 setup 写入 `hy-workflow.json`；deployment、workflow state、scope 和 DocsGraph 存在 OS 用户 config/state/cache 目录，不应提交。

### Artifact contract

- **setup 团队产物**: 固定允许 setup 维护根 `hy-workflow.json` 和 `.github/workflows/hy-workflow.yml`，以及 `AGENTS.md` 中 `<!-- hy-workflow-rules -->` 与 `<!-- /hy-workflow-rules -->` 之间的托管指令块；块外团队自定义指令由团队所有，setup 自动迁移块内版本时不改写块外内容。所有团队产物变化应以单独的 setup artifact sync PR 提交。
- **runtime/client/compat artifacts**: OS 用户 config/state/cache、客户端用户配置、.hy/、.opencode/、.codex/、.mcp.json、codelint.json、doclint.json、docs-gardener.json 都不提交。三个旧 JSON 仅可作为只读迁移或漂移输入，内置 lint 不创建或恢复它们。
- **unset 边界**: 只清理本机 deployment、registry、state/cache 和自己拥有的客户端配置，不删除团队维护的 `hy-workflow.json` 或 workflow。
- **兼容读取**: 旧用户 config 与带 mode 字段的 deployment manifest 仅作为只读迁移输入，不恢复模式选择，也不自动删除旧文件。
- **CI 强制**: workflow 只在 pull request 与手动触发时运行，并必须在确认的原生命令之后执行内置 doclint 和 codelint；不使用通用 push 触发。仓库管理员还必须在 GitHub ruleset/branch protection 中把对应 Verify check 设为 required。没有有效 checks 时 `hy_ci` 必须 fail closed。

### Promotion / release 例外

baseBranch → releaseBranch 的 promotion（例如 dev → main）属于发布/晋级操作，不是普通开发任务。
当用户明确要求“搞到 main”“promote dev to main”“发布到 main”时，不要伪造空 scope，也不要硬套 hy_branch → hy_edit → hy_verify → hy_commit。

promotion 操作必须满足：
- source 必须是已验证的 baseBranch（通常是 dev），target 必须是 releaseBranch（通常是 main）
- 先检查 origin/<target>..origin/<source> diff，确认只包含要发布的内容
- 创建或复用 promotion PR：base=<target>, head=<source>
- 等待 CI 全绿后再合并 PR
- 若需要直接使用 gh/git 执行 promotion，必须先获得用户明确授权
- 完成后可调用 hy_reset 清理 workflow 状态

普通代码/文档改动仍必须走完整 hy-workflow 闭环，禁止用 promotion 例外绕过开发流程。

### hy_reset

hy_reset 可在任意阶段调用，重置到 plan 阶段并清空当前工作数据。用于 PR 已合并且 hy_chain 完成后的正常收尾；也可在用户明确要求放弃当前开发任务时使用。

### hy_plan 使用

调用 hy_plan({task: "描述你要做的任务", plan: { ... PlanDoc JSON ... }})。构造 PlanDoc 时：
- 先调用 hy_read_docs({stage:"before_plan", task}) 建立文档事实基线，再用 Read/Glob/Grep 了解项目结构，确认每个文件路径存在
- task：描述解决的问题和动机，不是操作步骤列表
- dependency_dag：说明哪些模块受影响、哪些不受影响、依赖链方向
- entry_points：覆盖编译+lint+测试，每条对应一个验证维度
- risks：每条含场景+影响+缓解措施，不写一句话标签
- discussion：含至少一个备选方案及否定理由

### hy_plan 触发

仅在当前 phase 为 plan 且用户明确在发起开发任务时才调用 hy_plan。日常讨论、询问问题不算触发条件。
触发词包括 "计划一下"、"plan it"、"做个计划"、"做计划"、"plan this"、或用户描述开发任务意图时。

### approve 后自动推进

用户输入 approve 后，agent 必须先自动调用 hy_read_docs({stage:"before_approve"}) 完成文档审计；审计通过后再调用 hy_approve。hy_approve 被输入 "approve" 通过后，返回结果包含 pipeline 数组和 stopAfter。
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

<!-- /hy-workflow-rules -->
