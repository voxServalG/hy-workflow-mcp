<p align="center">
  <h1 align="center">hy-workflow</h1>
  <p align="center"><strong>让开发 Agent 按证据工作，而不是靠一段越来越长的 Prompt 记住流程。</strong></p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@voxstudio/hy-workflow"><img alt="npm latest" src="https://img.shields.io/npm/v/@voxstudio/hy-workflow/latest?color=cc3534&label=latest&style=flat-square"/></a>
  <a href="https://www.npmjs.com/package/@voxstudio/hy-workflow"><img alt="npm next" src="https://img.shields.io/npm/v/@voxstudio/hy-workflow/next?color=e8a22c&label=next&style=flat-square"/></a>
  <a href="LICENSE"><img alt="license MIT" src="https://img.shields.io/npm/l/@voxstudio/hy-workflow?style=flat-square"/></a>
</p>

hy-workflow 由一个严格 CLI 和 12 个阶段 Skill 组成。CLI 是状态、项目身份、scope、验证证据、lint 与 Git/GitHub 副作用的唯一权威；Skill 负责理解项目、形成计划、选择测试规模、解释结构化结果和与人协作。Skill 必须服从 CLI 返回的 `phase`、`stage`、`allowed` 与精确 `route.action.argv`，不能猜下一步，也不能自行读写 CLI 的私有状态。

这不是一个 MCP Server。发布包的唯一可执行入口是 `dist/main.js`，Agent 通过普通命令调用 `hy-workflow`。安装 helper 会把版本化 Skill bundle 投影到选中的 Codex、Claude Code 或 OpenCode 用户级 Skill 目录，但不会向仓库注入配置、Agent 文件、MCP 配置或 GitHub Actions。

## 安装

需要 Node.js 18 或更高版本；进入一个真实 Git worktree 后运行：

```bash
npm install -g @voxstudio/hy-workflow@latest
cd your-project
hy-workflow helper install --json
```

如果本机无法可靠探测 Agent，请明确指定目标，列表中不能包含空格：

```bash
hy-workflow helper install --clients codex,claude,opencode --json
```

`hy-workflow setup` 是 `helper install` 的兼容别名。安装成功后重启 Agent，使其重新发现 Skills。第一次处理该项目时，`hy-init` Skill 会调用 `hy-workflow init`；此后直接把开发任务交给 Agent 即可。


需要核对当前 CLI 实际携带的 Skill 时，直接读取包内内容，不要从项目目录猜版本：

```bash
hy-workflow skills list --json
hy-workflow skills read hy-status
hy-workflow skills read hy-verify --json
```

## 它解决什么问题

- 计划先于编辑。PlanDoc 必须基于当前本地文档事实，列出精确 scope、依赖方向、验证入口、风险和被否决的方案。
- 人只批准一次。CLI 把决定绑定到精确 PlanDoc；批准前的文档复核不是第二次人工审批。
- scope 可验证。Agent 用正常文件工具实现，但 scope 漂移、过期证据或新增外部依赖不能通过验证和发布 gate。
- 测试口径可解释。Skill 根据固定语义条件选择 Small、Medium、Large；CLI 判断已签发的验证清单是否完整并记录证据。
- 失败可恢复。提交、拉取请求、CI、合并和下游同步均保存精确身份与恢复收据，未知远端结果不会被当作成功或盲目重试。
- 多 Agent 共用一套规则。每个 Agent 读取同一版本的阶段 Skills，所有状态转换仍由同一个 CLI 内核裁决。

## 完整业务流程

```text
helper install
  -> init
  -> status
  -> read-docs(before_plan)
  -> plan
  -> 等待用户对当前 PlanDoc 作出一次明确决定
  -> approve
  -> read-docs(before_approve) 并按 CLI route 续行或重做计划
  -> branch
  -> edit 锁定 scope
  -> Agent 使用普通文件工具实现
  -> read-docs(after_edit)
  -> Agent 完成 scope 内文档修改
  -> sync-docs
  -> verify，或 exam-plan + exam-submit
  -> 必要时 amend-plan
  -> commit，其中包含 push、PR 和 commit.ci
  -> merge，其中包含结果对账和 merge.sync
  -> reset
```

日常不应手写这条流水线。每个阶段 Skill 先读当前 `status`，或复用上一份仍然有效的精确 route，然后只执行 CLI 允许的命令。人在真正需要决定时才会被打断。

## 测试规模怎么确定

测试规模不是让 CLI 猜，也不是让用户每次手工选择。Skill 读取 `init` 给出的生态与测试平台事实，再按下列固定条件形成 PlanDoc；CLI 以项目配置、scope、检查清单和结果证据判断是否完整。

- Small 对每个改动都需要。适用于单进程、确定性、无真实外部服务的静态检查、类型检查、目标单元测试和纯契约检查。只有行为完全留在一个模块内部时，Small 才可能足够。
- Medium 在跨模块、进程、文件系统、本地数据库、序列化、schema、公共 API、CLI、配置、并发或恢复状态时需要。它通常在单机上使用受控本地资源，耗时以分钟计。
- Large 在安装、升级、打包、发布、CI、跨平台、外部服务、安全边界、不可逆兼容性或历史重大事故只能端到端复现时需要。它应尽量针对最终安装产物和生产相似边界。

规模是语义，不是简单按耗时或测试文件数量分类。一个很快的安装迁移测试仍可能是 Large；一个较慢但完全隔离的属性测试仍可能是 Small。

## `init` 做什么

`init` 复活后承担“第一次认识项目”的职责，但严格保持本地只读。它验证外置 deployment 与配置权威，识别语言生态、源码布局、候选编译和测试命令、本地文档入口、当前 Git 状态、最近提交与 merge 历史，并返回 Small/Medium/Large 的固定判定合同。成功后只初始化 OS 用户目录中的状态并进入 `plan.before_plan`。

`init` 不访问飞书、Lark、团队知识库或任何外部资料，不 fetch 远端，不修改工作树，也不写 `.git`。本地没有可用的 PR 证据时，它会明确报告 unavailable，而不是用猜测补齐。

## 安装与升级边界

helper 使用三层结果报告：`skills`、`project`、`mcp`。

- `skills`：把包内 12 个 Skill 先写入用户级单一真相源，再以 symlink 或 copy 投影到选中的 Agent 目录。manifest 记录包版本、bundle hash、目标集合、投影模式和每个资源的内容 hash。
- `project`：只在 OS 用户 config/state/cache 中注册项目。新安装的 `projectFilesChanged` 永远是空数组，不写仓库或 `.git`。
- `mcp`：升级旧安装时，只退休 ownership manifest 能精确证明由 hy-workflow 拥有的同名 MCP 条目。`docs-gardener`、其他 MCP 条目和无法证明所有权的配置保持不变。

同一 checkout 的已有 deployment、配置、workflow state 和 scope 会逐字节保留。若 checkout 确实移动，helper 只在旧路径已消失、远端等价且 deployment/registry 精确配对时，以事务方式更新这两处 identity；配置、workflow state、scope、缓存、DocsGraph 和客户端 ownership 仍保持不变。升级不会把当前阶段重置成 `init`，不会要求重新批准，也不会借机删除旧仓库文件。仓库中已经提交的旧 `hy-workflow.json`、`.github/workflows/hy-workflow.yml`、`AGENTS.md` 托管块或客户端目录仍属于仓库历史；helper 不读取、修改或删除它们。旧 GitHub Actions 文件也会继续被 GitHub 独立执行，直到团队另开一个普通、可审查的清理 PR。

目标集合在一次安装生命周期内固定。要更换 Agent 目标或投影模式，先 `helper remove`，再明确重新安装。`helper update` 默认保留用户有意删除的投影；只有确认需要恢复时才使用 `--repair`。

```bash
hy-workflow helper status --json
hy-workflow helper update --json
hy-workflow helper update --repair --json
hy-workflow helper remove --json
```

`helper remove` 只移除仍能通过 ownership hash 证明归属的 Skill 投影和单一真相源。它保留项目外置配置、工作流状态、scope 和 MCP 现状，不会恢复已退休的 MCP Server。`hy-workflow unset` 是该操作的兼容别名。

## CLI 契约

工作流命令只接受一个 JSON 对象，通过 `--input` 或安全的普通文件 `--input-file` 传入。未知字段、重复选项、符号链接输入文件和超过 1 MiB 的输入会失败。每次调用只向 stdout 输出一个 `hy-workflow.cli.v1` JSON 文档：

```bash
hy-workflow status
hy-workflow read-docs --input '{"stage":"before_plan","task":"add rate limiting"}'
hy-workflow plan --input-file /tmp/plan-input.json
```

Skill 不应从自然语言提示猜命令。它读取 `route.action.argv` 并原样执行；如果 `control.stop` 为真，就先满足结构化的 `userAction` 或 `recovery`。CLI 输出不携带面向模型的 prompt、shell 字符串或自然语言操作指令，人的说明由当前阶段 Skill 从事实字段生成。

## lint 与 CI

`doclint` 和 `codelint` 是 CLI 内置、离线、第一方检查：

```bash
hy-workflow lint --json
```

它们应在本地先运行，并可由团队自己的 CI 再次调用。当前不提供模块依赖 lint，因为跨生态还没有足够稳定的共同模型。helper 永远不注入 GitHub Actions；是否在 CI 中调用、使用哪个 runner、如何安装语言工具链和哪些 checks 设为 required，都是消费仓库的团队策略。项目原生测试仍由项目自己的脚本与 CI 负责。

## 文件与状态边界

新安装不会产生任何需要提交的项目文件。Linux 默认使用 XDG config/state/cache/data 目录，macOS 使用用户 Library，Windows 使用 LocalAppData；具体绝对路径以 helper/status 和 CLI 结果为准。不要直接编辑这些私有文件，也不要把它们复制进仓库。

项目身份基于 Git worktree 与规范化 origin。GitHub SSH、HTTPS、大小写、默认端口、结尾 `/` 与 `.git` 的等价写法会解析为同一 identity；检测到多个活跃的旧 identity 时 fail closed，不会静默合并状态。

## 文档

- [产品愿景](./docs/product-vision.md)
- [架构与参考实现](./docs/architecture.md)
- [安装、升级和迁移](./docs/setup.md)
- [CLI 与输出合同](./docs/cli.md) · [输出](./docs/output.md)
- [状态机](./docs/state-machine.md) · [命令参考](./docs/tools.md)
- [阶段 Skills](./docs/skills.md) · [错误合同](./docs/errors.md)
- [npm 打包与发布](./docs/npm.md)

## 许可

MIT
