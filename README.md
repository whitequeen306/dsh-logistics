# dsh-logistics

**项目后勤，为 DeepSeek Harness 而生。**

安装后获得一组 `/logi-*` 命令：先把**整个项目**做成确定性的文件清单和审查单元，再让专家子代理逐单元审查，最后由**你当前的主会话模型**担任主编，合并证据、定级、写一份完整的项目报告。机器只负责事实、范围、收集和 contract 校验，不替你打分或做质量裁决。

> 0.5.0 起，审查命令只做**全项目审查**，不再审查工作区 diff 或最近一次提交；也没有 `/logi-diff` 或 `--diff`。`/logi-fix` 只按你明确给出的问题 ID 修复 `direct` 项。
>
> 0.5.1 起，run 目录会带命令后缀：`/logi` 为 `...-master`，单专家为 `...-<expert>`；`/logi` 的 handoff 按专家分目录（`handoff/<expert>/<expert>.json`），单专家保持平铺（`handoff/<expert>.json`）。旧的平铺 run 仍可读取。
>
> 从 CodeCortexLoop（MIT，原仓库留存于 [master 分支](https://github.com/whitequeen306/dsh-logistics/tree/master)）迁移而来。0.2.0 删除评分、基线与门禁；0.3.0 起改为「主编模型 + 薄机器层」；0.4.0 把范围从改动集改成整个项目；0.5.0 把 `report.md` 定为唯一核心交付物，并要求每位专家单独写报告；0.5.1 让 run 目录和 `/logi` 的 handoff 按命令/专家分目录。设计记录见 [MODULE-DECISION.md](./MODULE-DECISION.md)。

## 核心交付物

每次审查的最终产品是 **`.logistics/runs/<runId>/report.md`**：它必须能独立交给用户阅读，包含项目总览、单元 × 专家覆盖矩阵、按模块组织的问题、证据、修复顺序与覆盖缺口。`verdict.json` 只是机器判决和 `/logi-fix` 的输入，不能替代报告。

每位专家还会写一份自己的报告：`/logi` 在 `handoff/<expert>/<expert>.md`，单专家在 `handoff/<expert>.md`；总报告必须索引这些专家报告。报告缺失、过短或缺少关键章节时，`verdict.mjs` 会拒绝该次 run。

## 它能做什么

- **审查整个项目**：用 `git ls-files` 收集受版本控制（以及未忽略）的源码、配置和构建文件，按模块切成最多 12 个审查单元；不再只看最后一次提交。
- **一份核心项目报告**：报告先给项目总览和「单元 × 专家」覆盖矩阵，再按模块列出问题；哪个单元没覆盖、哪个专家失败，都会明确写出来。每位专家另有独立 Markdown 报告。
- **五个专家，按后果分工**：正确性、安全、健壮性（错误处理 + 测试）、可维护性（简化 + 清理）、性能（可选）。默认跑前四个。
- **证据优先**：问题必须有位置、证据、触发路径和影响；没有证据的严重问题会被降级，不会靠“感觉”报高优。
- **可选择修复**：报告中的 `direct` 项可以用 `/logi-fix <ID>` 交给一个串行 fixer；可先用 `--dry-run` 只出计划，真正执行前要求干净工作区、文件白名单、逐条测试与失败回滚。
- **DSH 原生**：命令由插件注册，专家通过内置 `subagent` 工具拉起；纯 ESM、零运行时依赖，不 import `@deepseek-ai/*`。

## 安装

要求：DeepSeek Harness `0.2.1` 或更新版本，Node.js `^22.19.0 || >=24.0.0`。

**DSH Desktop**：桌面版独占管理 `desktop` profile，命令行 `dsh plugin --profile desktop add` 会被拒绝。请打开 **Settings → Plugins → 安装第三方插件（Add plugin）**，填入本机**插件目录**的绝对路径：

```text
C:\path\to\dsh-logistics
```

安装完成后刷新或重启应用，输入 `/logi` 应能看到命令补全。

**CLI / 非桌面 profile**：

```bash
dsh plugin --profile web add dsh-logistics@0.5.1
dsh plugin --profile web add "C:/path/to/dsh-logistics"   # 本地开发
dsh --profile web --dump-config | grep -A2 dsh-logistics
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/logi` | 默认四专家审查**整个项目**：正确性、安全、健壮性、可维护性 |
| `/logi-correctness` | 只跑正确性专家，仍然覆盖整个项目 |
| `/logi-security` | 只跑安全专家，仍然覆盖整个项目 |
| `/logi-reliability` | 只跑健壮性专家，仍然覆盖整个项目 |
| `/logi-maintainability` | 只跑可维护性专家，仍然覆盖整个项目 |
| `/logi-perf` | 只跑性能专家，仍然覆盖整个项目 |
| `/logi-fix <ID...>` | 按报告中的 ID 执行指定 `direct` 修复项 |
| `/logi-fix --dry-run <ID...>` | 只出修复计划，不改源码 |

所有审查命令都支持在命令后补充关注点：

```text
/logi 优先看鉴权、支付回调、数据库迁移和前端权限判断
```

`/logi-fix` 必须带 ID，不支持无参数列出，也不支持 `--all`：一次只修你明确选择的 ID。`plan` 类型（需要设计决策）和性能项不会被自动执行。

每次审查（包括单专家命令）结束时，模型必须单独问一句：**“需要我帮你开始直接修复吗？还是你拿上报告去新开一个会话施行修复？”**

## 工作方式

```text
/logi-*
   │
   ├─ 1. 确定性事实（插件内 JS）
   │     git ls-files 全量清单、文件分类、模块归属、行数、
   │     审查单元划分、测试命令
   │     → .logistics/runs/<runId>/scope.json
   │
   ├─ 2. 注入派发消息（agent.followup）
   │     主会话模型成为「主编」：读 scope.json，
   │     派发 4 位专家；每位专家都要覆盖全部审查单元
   │
   ├─ 3. 子代理写 handoff
   │     .logistics/runs/<runId>-master/handoff/<expert>/<expert>.json
   │     每个 handoff 带 units 映射：reviewed / sampled / skipped
   │
   ├─ 4. 收集与候选材料
   │     collect.mjs 盘点每个单元的 reviewed/sampled/skipped/missing
   │     bundle.mjs 生成候选 finding、稳定 ID、单元 × 专家矩阵
   │
   ├─ 5. 主编裁决（主会话模型）
   │     模型自己合并/去重/定级/取舍，写 verdict.json + report.md
   │     verdict.mjs 只校验 contract，不判断内容好坏
   │
   └─ 6. 修复（可选）
         /logi-fix 按显式 ID 从最近一份完整 verdict.json 读取 direct 项
```

关键约束：

- **一个专家一个 child，不是「单元 × 专家」几十个 child**。每位专家收到完整单元清单，必须逐单元给出覆盖状态；这样大型项目也只需要 4–5 个子代理，但报告能看出哪个单元被真正看过。
- 父代理每条消息最多派发 **4 个**子代理；一轮结束后等完成通知，再继续下一波。
- 缺失或非法 handoff 会重试一次；第二次失败写 `status: "failed"`，不会被当成“没问题”。
- 子代理只读：不编辑源码、不提交、不删除、不嵌套子代理。
- 没有 `subagent` 工具时**不会**退化成父代理自己审：直接报告限制并停止。
- `collect.mjs` 的 `complete` 只表示“证据收齐”，不表示“审查通过”；`verdict.mjs` 不判断内容质量。

## 审查单元

`scope.json` 里的 `project.units` 是报告和覆盖矩阵的骨架：

```json
{
  "mode": "project",
  "project": {
    "units": [
      {
        "id": "u01",
        "label": "backend/lianyu-service (1/3)",
        "files": [{ "path": "backend/lianyu-service/pom.xml", "lines": 80 }],
        "stats": { "files": 120, "lines": 12117 }
      }
    ],
    "totals": {
      "trackedFiles": 1488,
      "reviewedFiles": 1102,
      "omittedFiles": 386,
      "units": 12,
      "lines": 150079
    }
  }
}
```

- 默认按 `backend/*`、`frontend/*`、`packages/*`、`apps/*`、`services/*` 等模块归组；小目录会合并，大模块按文件数拆成 `(1/N)`。
- `project.maxFilesPerUnit` 控制单个单元的文件数，`project.maxUnits` 控制单元总数，`project.maxFiles` 控制总审查文件上限。
- 文档、图片、依赖、构建产物、锁文件、`.logistics` 生成物不会进入审查；配置和构建描述（`pom.xml`、`package.json`、CI、Docker）会进入。
- 超过 `project.maxFiles` 会截断并写进 `totals.truncated`，报告必须说明。

## 运行日志

每次 `/logi*` 都会在 run 目录写一份可追溯日志：

```text
.logistics/runs/<runId>-master/     # 单专家命令为 <runId>-<expert>
  run.jsonl              # 每行一个事件：scope.created、dispatch.queued、
                         # dispatch.accepted/failed、collect.completed、
                         # bundle.completed、verdict.validated
  dispatch.md            # 实际注入给主会话模型的派发消息
  prompts/<expert>.md    # 每位专家实际收到的 child prompt
  scope.json             # 本次项目清单与审查单元
  handoff/<expert>/<expert>.json  # /logi：每位专家一个子目录
  handoff/<expert>/<expert>.md    # /logi：每位专家的独立 Markdown 报告（模型写）
                         # 单专家为 handoff/<expert>.json 与 handoff/<expert>.md
  verdict.json           # 主编裁决（机器校验 contract）
  report.md              # 核心交付物：完整项目报告（模型写）
```

`/logi-fix` 在 `.logistics/fixes/<fixRunId>/` 写同样的 `run.jsonl`、`dispatch.md` 和 `selection.json`。日志只记录命令元数据、路径、prompt、覆盖状态和 contract 结果，不写入 API key；prompt 会包含文件路径和审查范围，分享日志前请先检查是否含敏感路径。

`collect.mjs` 会额外打印每个单元的覆盖：

```text
units:
- u01 backend/lianyu-service (1/3): reviewed 3 / sampled 1 / skipped 0 / missing 0
- u02 backend/lianyu-service (2/3): reviewed 4 / sampled 0 / skipped 0 / missing 0
```

## 报告

```text
.logistics/
  runs/<runId>-master/        # 单专家为 <runId>-<expert>
    scope.json
    handoff/<expert>/<expert>.json  # /logi；单专家为 handoff/<expert>.json
    handoff/<expert>/<expert>.md    # 每位专家的独立报告
    handoffs.json             # bundle 生成的候选材料索引
    packet.md                 # 给主编的候选材料 + 单元 × 专家矩阵
    verdict.json              # 主编裁决（机器只校验 contract）
    report.md                 # 核心交付物：人读的完整项目报告
  latest.json
  fixes/<fixRunId>/
    selection.json
    fix.json
    fix-reverted.patch        # 仅失败回滚时出现
docs/logistics/latest.md      # 仅默认四模块完整时更新
```

报告包含：

- **项目总览**：项目根目录、HEAD、文件/单元/行数、本次覆盖的专家。
- **单元 × 专家覆盖矩阵**：每个单元被哪位专家标记为 reviewed / sampled / skipped；缺失和无效单独标出。
- **按模块分组的问题**：标题、位置、证据、影响、修复步骤、涉及文件、建议测试。
- **未覆盖维度**：哪些单元只 sampled、哪些 skipped、哪些 handoff 失败/缺失。
- **建议修复顺序**：同文件合并、根因先行、可维护性单独批次、性能单独批次。
- **专家报告索引**：`/logi` 为 `handoff/<expert>/<expert>.md`，单专家为 `handoff/<expert>.md`；每位专家另有独立报告。

`report.md` 是核心交付物；`verdict.mjs` 会检查它是否存在、长度、关键章节、是否出现全部单元 ID、finding 是否有 `file:line`，以及专家报告是否存在且被总报告索引。报告不达标时，该次 run 不能算完成，也不会更新 `latest`。

每个 finding 有稳定 ID，例如 `SEC-4F2A1`。ID 由 `专家 | 类别 | 文件 | 归一化标题` 计算，**不含行号**；代码移动不会让同一个问题换 ID。跨专家报告同一根因时，由主编决定保留哪一条，其余写入 `verdict.json` 的 `dropped`。

`verdict.json` 的 schemaVersion 为 `2`，是稳定接口；`docs/logistics/latest.md` 与 `.logistics/latest.json` 只在**默认四模块完整覆盖**时更新，单模块或部分覆盖会保留上一份完整报告。

### 为什么没有健康分

不同模块的问题后果不同，用一个分数把它们相加会掩盖“安全阻断项”和“命名建议”的差别。报告改用：

- 严重度：`critical / high / medium / low / info`
- 可执行性：`direct`（机械、行为保持、可验证）或 `plan`（需要设计决策）
- 覆盖状态：单元级 reviewed / sampled / skipped；专家级完整 / 部分 / 失败 / 缺失

## 修复

`/logi-fix` 是唯一的写操作入口，默认安全优先：

1. **必须给 ID**：不带参数会直接报错，不提供“列出全部 direct 项”的入口。
2. **计划**：`--dry-run <ID...>` 输出每个 ID 的位置、白名单文件、测试和步骤。
3. **执行**：带 ID 且不带 `--dry-run` 时，要求：
   - 最近 `verdict.json` 通过 contract 校验、`schemaVersion = 2` 且覆盖完整；
   - git 仓库、工作区没有未提交的源码改动；
   - 判决生成后 HEAD 未变化（否则证据可能过期）；
   - ID 存在、`kind = direct`、不属于性能模块。
4. 通过后创建 `.logistics/fixes/<fixRunId>/selection.json`，派发**一个** fixer 子代理。
5. fixer 只改白名单文件，逐条运行 `scope.testCommands`（没有多命令时回退到 `scope.testCommand`）；失败时保存 `fix-reverted.patch`、回滚该组改动，并在 `fix.json` 标记 `failed` / `partial`。
6. 不会自动 commit、push、安装依赖或联网。

> 审查阶段仍然只读。`/logi-fix` 不会复用审查子代理，也不会让多个专家并行改代码。

## 配置

可选文件 `.logistics/config.json`：

```json
{
  "ignore": ["fixtures/**", "**/*.snap"],
  "maxFindingsPerPass": 12,
  "project": {
    "maxFiles": 2000,
    "maxFilesPerUnit": 120,
    "maxUnits": 12
  },
  "testCommand": "pnpm test",
  "modules": {
    "packages/api": "API 服务",
    "apps/web": "Web 前端"
  },
  "models": {
    "security": {
      "provider": "wb",
      "model": "glm-5.3",
      "reasoningEffort": "high"
    }
  }
}
```

- `ignore` 会追加在内置忽略规则之后（`node_modules`、`dist`、锁文件、`.logistics`、`docs/logistics` 等始终忽略）。
- `project.maxFiles`：送入审查的文件总上限，默认 2000；超出时截断并写 `totals.truncated`。
- `project.maxFilesPerUnit`：单个审查单元的文件上限，默认 120；大模块会拆成 `(1/N)`。
- `project.maxUnits`：审查单元总数上限，默认 12；小目录会合并。
- `maxFindingsPerPass`：单个专家最多保留的问题数，默认 12；超过会被判无效，不会静默截断。
- `testCommand`：显式指定测试命令，会覆盖自动检测；为空时自动从根目录和一级子目录的 `package.json` / Maven / Gradle / `pytest` / `go` / `cargo` 推断，最多返回 8 条（例如前端 npm、后端 Maven、Python sidecar 各一条）。
- `modules`：模块显示名覆盖；不配置时按 `packages/*`、`apps/*`、去掉 `src`/`lib`/`app` 前缀后的首段推导。
- `models`：按专家指定 `provider` / `model` / 可选 `reasoningEffort`。只有 DSH 开启子代理模型选择且该路由被允许时才生效；否则自动回退到父会话模型，不会中断任务。

配置值非法时会回退到默认值并给出警告，不会让命令直接崩掉。

### 关于“要不要加 perf”

`/logi` 默认只跑四位专家：correctness / security / reliability / maintainability。它**不会自动追加**性能专家；需要性能审查时单独执行 `/logi-perf`，该命令同样覆盖整个项目。

`/logi` 的报告必须写“性能维度未运行，需要时执行 `/logi-perf`”，不能把未检查当成没问题。

## 适用边界

- **审查只读**：`/logi-*` 审查命令不会改源码；只有 `/logi-fix` 且显式给 ID 时才写文件。
- **一位专家覆盖整个项目**：大型项目里专家会做跨文件模式扫描并抽样读关键文件，`handoff.units` 的 `sampled` / `skipped` 是诚实的覆盖声明；不要把 `sampled` 当成逐行审查。
- **不是编译器**：静态分析基于专家判断；跨仓库、运行时才暴露的问题可能漏报。
- **部分覆盖不等于通过**：单模块报告只代表该模块，报告会明确标出未覆盖单元和维度。
- **大型项目**：默认最多 2000 个文件、12 个单元、单专家 12 条问题；更大的仓库可调高 `project` 上限，或分目录建立多个 run。
- **性能需要证据**：`/logi-perf` 只报热路径，且性能项永远是 `plan`，不会自动改。

## 开发

```bash
npm test          # node --test，81 个测试（含全项目 scope、单元覆盖、报告契约、端到端 contract 与运行日志）
npm run check     # 语法检查 + 全部测试
```

目录：

```text
lib/
  index.js        # DSH 入口：注册 6 个 skill、7 个命令
  commands.js     # 命令 handler：全项目 scope、派发、/logi-fix
  project.js      # 全项目文件分类、模块划分、审查单元
  scope.js        # git 清单、单元落盘、多模块测试命令、scope.json
  dispatch.js     # 主编/子代理 prompt、collect/bundle/verdict 命令
  handoffs.js     # handoff 校验、单元覆盖、专家报告、矩阵
  report-check.js # report.md 与专家报告的 contract 校验
  test-command.js # 一条/多条测试命令的展示
  handoff-paths.js # run/handoff 路径：/logi 嵌套，单专家平铺，旧 run 兼容
  verdict.js      # 主编裁决 contract 校验
  findings.js     # 归一化、稳定 ID、模块归属、排序
  config.js       # .logistics/config.json
  constants.js    # 5 个模块、severity、默认配置
  runlog.js       # run.jsonl、prompt/dispatch 日志
  util.js         # git/glob/id/文件工具
  cli/            # collect / bundle / verdict / status / aggregate
skills/
  logi-correctness/
  logi-security/
  logi-reliability/
  logi-maintainability/
  logi-perf/
  logi-fix/
```

## License

MIT。迁移自 CodeCortexLoop；原项目与作者信息见 [LICENSE](./LICENSE) 与 git 历史。
