# Acceptance gates

本项目有两个互补 gate，不能互相替代。

## Dev acceptance baseline

npm run test:acceptance:baseline 是每次进入 dev 前的项目级、离线、确定性 baseline；npm run verify:dev 先执行常规 verify，再执行该 baseline。独立 workflow .github/workflows/acceptance-baseline.yml 在 PR target 为 dev 及 push 到 dev 时运行，稳定 check 名为 Acceptance Baseline，仓库 ruleset 应将它设为 required。

baseline 先 npm pack，检查 tarball 不含源码、测试和本地运行态，再从解包后的 dist 执行产品。它不访问 registry 或外部仓库；运行依赖来自本次 npm ci，docs-gardener 使用只实现版本与 MCP catalog 握手的有限 stub。隔离 HOME、XDG、客户端状态、npm prefix/cache 和凭证边界沿用 acceptance harness。

test/acceptance/baseline-matrix.json 用六个确定性 fixture 覆盖 Node/main、TypeScript/dev monorepo、Python/trunk、Rust/master、混合语言/非标准目录，以及 `INC-LINT-INTERNAL-OFFLINE`。每个 fixture 必须绑定唯一 INC-* 历史事故 ID，并执行 dry-run 无副作用、两次 setup 收敛、offline doctor、项目文件边界、unset 保留团队产物与清理 runtime artifacts；lint fixture 还证明已安装 tarball 能离线产出十条规则的统一报告，且三个旧兼容 JSON 不出现。场景不得 skip；缺项、超时、非零退出、非 JSON envelope、边界越界或清理不完整均 fail closed。

新增重大 bug 时，修复 PR 必须先增加能复现该 bug 的事故 fixture/oracle；优先扩展现有 pairwise fixture，只有出现新的独立项目维度才增加 fixture。baseline 不负责公网兼容压力，也不允许以减少 release 场景换取速度。

## Release acceptance pressure

npm run test:acceptance 保持兼容入口，等价于 npm run test:acceptance:pressure。它是发布专用、允许联网、45 分钟预算的完整压力门禁，不属于 npm test 或日常 dev baseline。runner 测试同一个 canonical tarball，并安装固定的 @voxstudio/docs-gardener@1.0.0-next.0。

release matrix 固定为五个公开仓库：Vite、Flask、Express、GitHub CLI、ripgrep；HTTPS URL、full commit、生态、分支和预期目录都在 test/acceptance/matrix.json。本地可通过各仓库的 HY_ACCEPTANCE_*_MIRROR 指向含精确 commit 的只读 clone；未提供时才走有界 HTTPS fetch。release workflow 预先 checkout 五个固定 commit，再把本地路径传给 runner。

release pressure 直接通过已安装 tarball 运行统一内置 lint，不下载或准备第三方 lint 包。它允许真实仓库存在结构化 lint findings，但要求报告 schema、十条规则、适用性、计数、确定性顺序和退出码一致，并证明兼容 JSON 字节不变。其余覆盖仍包括 PTY、managed AGENTS 迁移、客户端 shadow refusal、artifact drift、32 并发 setup、七个持久化 failpoint 的精确回滚、MCP 文档读取、unset、进程树/磁盘预算、远程写拒绝和 worktree 边界。任何 timeout、partial result、skip、零文件假绿或 structured evidence 缺失都失败。

## Verify integration

baseline 和 pressure 都是长命令。PlanDoc 应把它们列入 tests/entry points，但执行时使用异步 verify-as-oracle：hy_exam_plan 获取带 nonce 的精确命令，agent 在 MCP 外执行并收集退出码与 stdout tail，再用 hy_exam_submit 阅卷。不要把长 acceptance 塞进同步 hy_verify；两个 verify 路径成功后生成等价 verifyHash；异步阅卷还必须原子持久化 implementation manifest、manifest hash 和 implementation digest，hy_commit 才能消费该证据。
