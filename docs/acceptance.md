# Acceptance gates

本项目有两个互补 gate，不能互相替代。

## Dev acceptance baseline

npm run test:acceptance:baseline 是每次进入 dev 前的项目级、离线、确定性 baseline；npm run verify:dev 先执行常规 verify，再执行该 baseline。独立 workflow .github/workflows/acceptance-baseline.yml 在 PR target 为 dev 及 push 到 dev 时运行，稳定 check 名为 Acceptance Baseline，仓库 ruleset 应将它设为 required。

baseline 先 npm pack，检查 tarball 不含源码、测试和本地运行态，再从解包后的 dist 执行产品。它不访问 registry 或外部仓库；运行依赖来自本次 npm ci，docs-gardener 使用只实现版本与 MCP catalog 握手的有限 stub。隔离 HOME、XDG、客户端状态、npm prefix/cache 和凭证边界沿用 acceptance harness。

test/acceptance/baseline-matrix.json 用六个确定性 fixture 覆盖 Node/main、TypeScript/dev monorepo、Python/trunk、Rust/master、混合语言/非标准目录，以及 `INC-LINT-INTERNAL-OFFLINE`。每个 fixture 必须绑定唯一 INC-* 历史事故 ID，并执行 dry-run 无副作用、两次 setup 收敛、offline doctor、项目文件边界、unset 保留团队产物与清理 runtime artifacts；lint fixture 还证明已安装 tarball 能离线产出十条规则的统一报告，且三个旧兼容 JSON 不出现。场景不得 skip；缺项、超时、非零退出、非 JSON envelope、边界越界或清理不完整均 fail closed。

新增重大 bug 时，修复 PR 必须先增加能复现该 bug 的事故 fixture/oracle；优先扩展现有 pairwise fixture，只有出现新的独立项目维度才增加 fixture。baseline 不负责公网兼容压力，也不允许以减少 release 场景换取速度。

`INC-MERGE-UNKNOWN-OUTCOME` 是 merge recovery 的离线确定性事故 oracle，不增加新的项目矩阵维度。它必须覆盖以下不变量：

- immutable identity（repository、PR number、base、head、verified head OID）不随 GitHub lifecycle 变化；mutation 前持久化 attempted receipt，远端合入确认后再持久化 confirmed receipt，后续重试不能第二次调用 merge mutation。
- merge mutation 实际成功但命令报错或工具进程中断时，reconciliation 能从 GitHub postcondition 或 fresh Git ancestry 恢复。GitHub lifecycle 不可用时，只有 fresh fetch 后 verified head 是 immutable `baseOid` 的祖先，才返回 `already_integrated` 与 `evidence: "git"`；非祖先或 fetch 不可用时返回 `PR_MERGE_OUTCOME_UNCONFIRMED`。
- 正常 pre-mutation candidate 必须同时满足 agent branch 约束、verified-head ancestry、fresh prepared-base ancestry，以及 snapshot 时 local OID 等于 remote OID。legacy no-receipt 已集成恢复只重建由 agent prefix、verified-head ancestry 与 local=remote 证明的真实 stacked branch；unrelated branch 忽略，真实 stack 的 local/remote 漂移返回 `POST_MERGE_SYNC_INCOMPLETE` 且不覆盖。
- confirmed receipt 首次同步要求 fresh remote base 包含 verified OID 与确认时的 base OID，再固定 exact `syncBaseOid`；后续恢复要求 remote tip 仍与 pin 完全相等，否则以 retryable `POST_MERGE_SYNC_INCOMPLETE` fail closed。每个候选通过 `detached staging` rebase，先持久化 `rebasing` 意图和 `resultOid`，再用 local ref `compare-and-swap` 安装结果，最后以 exact `force-with-lease` 更新远端。local 或 remote OID 漂移都不能被覆盖。
- 远端已确认但同步失败时返回 `POST_MERGE_SYNC_INCOMPLETE`，并准确报告 completed/remaining work；重试只继续未完成同步。成功结果分别为 `merged_now`、`already_merged` 或 `already_integrated`，并报告实际 `data.executor`。
- `read-only Git fallback` 从不 merge 或 push base。事故 oracle 覆盖完成状态写入后的普通工具/进程中断，不把尚未声明的断电、内核崩溃或 `fsync` durability 当作已验证保证。

## Release acceptance pressure

npm run test:acceptance 保持兼容入口，等价于 npm run test:acceptance:pressure。它是发布专用、允许联网、45 分钟预算的完整压力门禁，不属于 npm test 或日常 dev baseline。runner 测试同一个 canonical tarball，并安装固定的 @voxstudio/docs-gardener@1.0.0-next.0。

release matrix 固定为五个公开仓库：Vite、Flask、Express、GitHub CLI、ripgrep；HTTPS URL、full commit、生态、分支和预期目录都在 test/acceptance/matrix.json。本地可通过各仓库的 HY_ACCEPTANCE_*_MIRROR 指向含精确 commit 的只读 clone；未提供时才走有界 HTTPS fetch。release workflow 预先 checkout 五个固定 commit，再把本地路径传给 runner。

release pressure 直接通过已安装 tarball 运行统一内置 lint，不下载或准备第三方 lint 包。它允许真实仓库存在结构化 lint findings，但要求报告 schema、十条规则、适用性、计数、确定性顺序和退出码一致，并证明兼容 JSON 字节不变。其余覆盖仍包括 PTY、managed AGENTS 迁移、客户端 shadow refusal、artifact drift、32 并发 setup、七个持久化 failpoint 的精确回滚、MCP 文档读取、unset、进程树/磁盘预算、远程写拒绝和 worktree 边界。任何 timeout、partial result、skip、零文件假绿或 structured evidence 缺失都失败。

## Verify integration

baseline 和 pressure 都是长命令。PlanDoc 应把它们列入 tests/entry points，但执行时使用异步 verify-as-oracle：hy_exam_plan 获取带 nonce 的精确命令，agent 在 MCP 外执行并收集退出码与 stdout tail，再用 hy_exam_submit 阅卷。不要把长 acceptance 塞进同步 hy_verify；两个 verify 路径成功后生成等价 verifyHash；异步阅卷还必须原子持久化 implementation manifest、manifest hash 和 implementation digest，hy_commit 才能消费该证据。
