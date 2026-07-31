<!-- hy-workflow-rules -->
<!-- hy-workflow-rules-version: 2026.07.31.1 -->

## hy-workflow CLI + Skill 工作规则

本仓库使用 `hy-workflow` CLI 保存严格状态、证据和路由，并用 12 个阶段 Skill 负责理解项目、形成计划、选择测试规模和向用户解释。CLI 是 `phase`、`stage`、scope、批准、验证证据及 Git/GitHub 副作用的唯一权威；Skill 必须听从 CLI，不能猜测下一步或直接读写私有状态。

本托管块是仓库当前版本自行维护的团队说明。`hy-workflow helper` 不会创建、更新或删除 `AGENTS.md`，也不会向项目注入配置、MCP 文件或 GitHub Actions。

### 开始与路由

首次使用先确保用户已运行 `hy-workflow helper install` 并重启 Agent，然后调用 `hy-workflow init`。后续任务在没有刚刚返回且仍有效的精确 route 时，先调用：

```bash
hy-workflow status
```

`route.action.argv` 非空时保持每个元素边界并原样执行；`control.stop` 为真时先完成结构化 gate。argv 为空但 `route.action.command` 非空时，只把 envelope 交给该命令对应的 Skill；该 Skill 只能按 `inputRequired` 声明的 source 补齐字段，保留已有 `input`，不得添加其他字段。command 也为空时，只能处理显式 `route.choices`、外部 target、recovery 或终态，禁止从 allowed 集合、自然语言、phase/stage、旧会话或外置状态文件猜下一步。

### 固定业务流程

```text
init
-> read-docs(before_plan)
-> plan
-> 等待用户对完整 PlanDoc 作出一次明确决定
-> approve
-> read-docs(before_approve)
-> 按 route 延续原决定或 replan
-> branch
-> edit 锁定 scope
-> 使用正常文件工具实现
-> read-docs(after_edit)
-> 完成 scope 已声明的文档修改
-> sync-docs
-> verify，或 exam-plan + exam-submit
-> 必要时 amend-plan
-> commit（包含 commit.prepare、commit.publish、commit.ci）
-> merge（包含 merge.reconcile、merge.sync）
-> reset
```

没有独立的 `ci` 或 `chain` 命令。不得跳过验证直接发布，不得用直接 Git/GitHub 命令绕过当前 route。

### CLI 输入

工作流命令只通过 `--input '<JSON object>'` 或 `--input-file <regular-file>` 接收输入。例如：

```bash
hy-workflow read-docs --input '{"stage":"before_plan","task":"具体开发任务"}'
hy-workflow branch --input '{"category":"fix","topic":"retry-recovery"}'
```

不要把 `route.action.argv` 拼成 shell 字符串；按 argv 数组原样执行。CLI 的 `hy-workflow.cli.v1` 输出是机器事实，不包含面向模型的 prompt。当前 Skill 应把结构化事实转成清楚的人类说明，而不是把整段原始 JSON 扔给用户。

### `init`

`init` 只使用本地只读信息认识项目：渐进披露文档入口、manifests/lockfiles、源码布局、编译与测试配置、当前 Git 状态、最近提交和本地 merge 记录。它不访问飞书、Lark、团队知识库、远端 PR API 或 Web，不 fetch，不改工作树，也不写 `.git`。没有本地证据时明确报告 unavailable。

### PlanDoc 与一次批准

PlanDoc 必须包含问题与期望状态、精确 changes/new_files/delete scope、依赖方向和不受影响边界、环境搭建、具体编译/lint/测试入口及预期退出码、场景-影响-缓解形式的风险，以及至少一个备选方案和否定理由。

向用户完整、清楚地展示当前 PlanDoc，只有明确的 approve/reject/revise 才能提交 `approve`。同一 PlanDoc 的 `before_approve` 文档审计不是第二次人工批准；无实质漂移时按 CLI route 延续原决定，有实质漂移时选择 continue 或 replan。不得代替用户批准，也不得因沉默或“继续做”推断批准。

### Small、Medium、Large 测试口径

测试规模由 Skill 按固定语义条件判断，CLI 负责判断已签发证据是否完整：

- Small 每次改动都要有；覆盖单模块、确定性、隔离的静态、类型、单元和纯契约检查。
- Medium 在跨模块、进程、文件系统、本地数据库、序列化、schema、公共 API、CLI、配置、并发或恢复状态时必须加入。
- Large 在安装、升级、打包、发布、CI、跨平台、外部服务、安全边界、不可逆兼容性或历史重大事故需要端到端复现时必须加入。

规模不是耗时标签。不得因为 Small 通过就删掉必须的 Medium/Large；重大历史 bug 和项目不变量应成为可审查的测试或 fixture。

### 编辑和文档

`edit` 只锁定 scope，真正修改由 Agent 的正常文件工具完成。只能编辑 PlanDoc 声明的文件，并保留无关用户改动；发现必要路径不在 scope 时必须停下走 amendment route。

实现后先执行精确的 `read-docs(after_edit)` route，再完成 scope 已声明的文档修改，最后调用 `sync-docs` 记录证据。`sync-docs` 不替你写文档。

### 验证、提交与合并

短套件使用 `verify`。长套件使用 `exam-plan`，逐条原样执行签发的命令并带回完整 nonce/exit/output 结果，再用 `exam-submit` 一次提交。实现或 PlanDoc 改变后旧试卷失效，修复后必须重新完成 after_edit、sync-docs 并领取新试卷。

验证失败回 edit；CI 红色也回 edit；CI pending 或 API 暂时异常留在 `commit.ci`，等待后只重试 route 指定的 `commit`。没有 checks 或只有 skipped/neutral 不是成功。

`commit` 和 `merge` 的不确定结果必须使用 CLI 的恢复记录对账，禁止直接再次 push、建 PR 或 merge。只有 `merge.sync` 完成并进入 done 后才调用 reset。

### 安装、lint 与项目文件边界

helper 只在用户目录安装 Skills 和保存外置状态。fresh install 的 `projectFilesChanged` 必须为空，不写 `hy-workflow.json`、workflow、`AGENTS.md`、`.mcp.json`、`.codex/`、`.opencode/` 或 `.git`。已有 deployment、config、workflow state 和 scope 在迁移中逐字节保留；只退休能够精确证明所有权的旧 `hy-workflow` MCP 条目，保留 `docs-gardener` 和其他配置。

doclint 与 codelint 是本地、离线、第一方 CLI 功能：

```bash
hy-workflow lint --json
```

当前不提供依赖模块 lint。helper 不注入 GitHub Actions；CI 是否调用 lint、原生工具链如何搭建以及 required checks 如何配置，均由仓库团队决定。

不要提交用户级 config/state/cache/data、Skill 投影、`.hy/`、项目 Agent 目录、MCP 配置或旧 lint JSON。仓库中已经跟踪的旧注入只能通过单独、可审查的普通 PR 清理，升级 helper 不会代为修改。

### Promotion / release 例外

baseBranch 到 releaseBranch（例如 dev 到 main）的 promotion 是发布操作，不要伪造空 scope。必须由用户明确授权，核对精确 source/target diff，创建或复用 promotion PR，等待真实 CI 全绿后合并。该例外不能用于绕过普通代码或文档改动流程。

<!-- /hy-workflow-rules -->
