# hy-workflow MCP

> 让任何开发 agent（Claude Code / Codex / OpenCode 等）听话的工作流守门员。
>
> agent 必须：**先读文档 → 先做计划 → 等你批准 → 锁定要改的文件 → 实现 → 同步文档 → 本地验证 → 才能提交/提 PR/等 CI/合并**。不再跳步、不再乱改文件、不再把本地缓存混进 PR。

---

## 30 秒上手

### 1. 安装（一行）

```bash
npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest
```

国内网络加镜像：

```bash
npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest --registry=https://registry.npmmirror.com
```

要求 Node.js ≥ 18、`git` 在 PATH、`gh` 已登录（要用来建 PR 和查 CI）。

### 2. 在你的项目里跑 setup

```bash
cd 你的项目根目录
hy-workflow setup
```

setup 会自动：
- 识别项目语言（JS/TS/Python/Go/Rust）、源文件目录、主分支、文档目录
- 为 Codex / Claude Code / OpenCode 配好 MCP（不写项目级配置，只改你本机客户端的用户配置）
- 在仓库里写入 / 更新三个**团队共有文件**（提交到 git 的）：
  - `hy-workflow.json`：项目工作流配置（主分支、语言、文档目录、CI 命令）
  - `.github/workflows/hy-workflow.yml`：CI 上跑 doclint + codelint
  - `AGENTS.md` 里的 `<!-- hy-workflow-rules -->` 托管块：agent 规则（块外你写的团队自定义指令字节级保留，setup 只替换块内）
- 推断你的 CI 命令（识别 `npm test` / `cargo test` / `pytest` 等），让你确认

完了**重启你的 MCP 客户端**（Claude Code / Codex / OpenCode），在对话里让 agent 调 `hy_status` 就能看到当前阶段。

### 3. 第一次对话里跟 agent 说什么

直接说你要做的事，比如：

> 帮我给这个项目的登录接口加个 rate limit，先做个计划。

agent 会自动：
1. 调 `hy_read_docs(before_plan)` 读 `docs/` 目录建事实基线
2. 调 `hy_plan` 产出 PlanDoc（改哪些文件、怎么验证、风险）
3. **停下来等你回复 `approve`**（调 `hy_approve`）
4. 你批准后才建分支、改代码、跑验证、提 PR

只要在对话里看到 PlanDoc 摘要，你看一眼回 `approve`，剩下的 agent 自己跑。

---

## 最常见的三个问题

### Q1: agent 说 "setup update required / tool mismatch" 怎么办？

你升级了 `@voxstudio/hy-workflow` 全局包。回项目根目录重跑：

```bash
hy-workflow setup
```

然后重启 MCP 客户端。

### Q2: agent 说需要 `hy_init` 怎么办？

说明这个项目还没在你这台机器上初始化过。在终端跑：

```bash
hy-workflow setup
```

（`hy_init` 是 MCP 工具，**不会改你项目文件**；真正写项目文件的只有 `hy-workflow setup` CLI。）

### Q3: setup 提示 "Project type is mixed; explicit confirmation is required" 怎么办？

项目里同时有多种语言（比如 `.ts` + `.js`），setup 不敢自己猜。手动传参数：

```bash
hy-workflow setup --yes --clients codex,claude,opencode \
  --ci-command 'npm ci' --ci-command 'npm test' \
  --json
```

或者先写一个 `hy-workflow.json`（见 [docs/setup.md](./docs/setup.md)）。

---

## 工作流长什么样（给想看全貌的人）

首次接入项目：

```text
setup TUI → restart client → hy_init → hy_read_docs(before_plan) → hy_plan
```

之后每个改动：

```text
hy_status
→ hy_read_docs(before_plan)      # 先读文档建基线
→ hy_plan                         # 产出计划给你看
→ 你 approve                      # 回复 approve 放行；回复别的就是驳回
→ hy_read_docs(before_approve)    # 二审计划没飘
→ hy_branch                       # 建分支
→ hy_edit                         # 锁定 scope，agent 只能改计划里的文件
→ （agent 改代码/文档）
→ hy_read_docs(after_edit)        # 审计实现 diff
→ hy_sync_docs                    # 同步文档（如有）
→ hy_verify                       # 本地 lint + 编译 + 测试
→ （必要时 hy_amend_plan 小改 scope，你再 approve 一次）
→ hy_commit                       # git add + commit + push + 建 PR
→ hy_ci                           # 等 GitHub CI 绿
→ hy_merge                        # 合并 PR
→ hy_chain                        # rebase 下游分支（没有就空数组）
→ hy_reset                        # 回到 plan，准备下一个任务
```

更细的工具说明：[docs/tools.md](./docs/tools.md)，状态机：[docs/state-machine.md](./docs/state-machine.md)。

---

## 文件边界（哪些要提交，哪些不要）

| 类别 | 文件 | 处理方式 |
| --- | --- | --- |
| setup 团队产物（提交到仓库） | `hy-workflow.json`、`.github/workflows/hy-workflow.yml`、`AGENTS.md` 中 `<!-- hy-workflow-rules -->` 托管块 | setup 自动维护；块外自定义指令属于团队，setup 不动 |
| runtime/client 产物（**不要提交**） | `~/.config/hy-workflow/`、`~/.local/state/hy-workflow/`、`~/.cache/hy-workflow/`、MCP 客户端用户级配置 | 在你本机用户目录，不进仓库；`hy-workflow unset` 清当前项目 |
| legacy/compat（**不要提交**） | `.hy/`、`.opencode/`、`.codex/`、`.mcp.json`、`codelint.json`、`doclint.json`、`docs-gardener.json` | 仅在旧 CLI 运行时临时生成，setup/unset 不删团队文件 |

setup 改了团队文件应当单独开一个 "setup artifact sync" PR 提交，不要混进业务 PR。

---

## 想卸？

```bash
cd 你的项目根目录
hy-workflow unset
```

unset 只删你本机的 deployment/state/cache 和客户端 MCP 登记，**不删仓库里的 `hy-workflow.json`、workflow 和 AGENTS.md**——那些是团队文件，要走正常 PR 才能改。

---

## Codex / Claude Code / OpenCode 配置长什么样

setup 会自动写，一般不用手改。期望态：

```toml
# ~/.codex/config.toml （Codex 用户级）
[mcp_servers.hy-workflow]
command = "hy-workflow"
startup_timeout_sec = 60
tool_timeout_sec = 300

[mcp_servers.docs-gardener]
command = "docs-gardener"
args = ["mcp"]
startup_timeout_sec = 60
tool_timeout_sec = 300
```

Claude Code 和 OpenCode 的配置格式类似，setup 会写到对应的用户级配置文件里。

---

## 深入文档

完整合同文档入口：[docs/index.md](./docs/index.md)。常用几篇：

- [Setup 详解](./docs/setup.md)
- [工具参考](./docs/tools.md)
- [CLI 契约](./docs/cli.md)
- [架构](./docs/architecture.md)
- [状态机](./docs/state-machine.md)
- [verify pipeline](./docs/verify.md)
- [发布验收](./docs/acceptance.md)

---

## 验证工具

`hy_verify` 做本地 gate：compile → scope → boundary → platform → smoke → tests。
setup 生成的 GitHub Actions workflow 先跑你确认的 `ci.commands`，再强制跑固定版本 doclint/codelint。
CI 没命令、命令超时/失败、doclint/codelint 扫零文件、没有 checks 或只有 skipped/neutral 都 **fail closed**。
仓库管理员需要在 GitHub ruleset / branch protection 里把 `Verify` check 设为 required（setup 不越权改管理配置）。

---

## 自举

本项目自己也用 hy-workflow 管理。

## 许可

MIT
