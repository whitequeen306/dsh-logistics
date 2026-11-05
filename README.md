# dsh-logistics

**项目后勤，为 DeepSeek Harness 而生。**

安装后获得一组 `/logi-*` 命令：先把**整个项目**做成确定性的文件清单和审查单元，再让专家子代理逐单元审查，最后由**你当前的主会话模型**担任主编，合并证据、定级、写一份完整的项目报告。机器只负责事实、范围、收集和 contract 校验，不替你打分或做质量裁决。

> 0.5.0 起，审查命令只做**全项目审查**，不再审查工作区 diff 或最近一次提交；也没有 `/logi-diff` 或 `--diff`。0.6.0 起移除 `/logi-fix`：需要修复时，把报告或指定 finding 直接交给当前主模型。
>
> 0.5.1 起，run 目录会带命令后缀：`/logi` 为 `...-master`，单专家为 `...-<expert>`；`/logi` 的 handoff 按专家分目录（`handoff/<expert>/<expert>.json`），单专家保持平铺（`handoff/<expert>.json`）。旧的平铺 run 仍可读取。
>
> 从 CodeCortexLoop（MIT，原仓库留存于 [master 分支](https://github.com/whitequeen306/dsh-logistics/tree/master)）迁移而来。0.2.0 删除评分、基线与门禁；0.3.0 起改为「主编模型 + 薄机器层」；0.4.0 把范围从改动集改成整个项目；0.5.0 把 `report.md` 定为唯一核心交付物，并要求每位专家单独写报告；0.5.1 让 run 目录和 `/logi` 的 handoff 按命令/专家分目录；0.6.0 移除 `/logi-fix`，插件不再提供写操作命令；0.6.1 在报告 contract 前增加确定性脱敏和残留凭据扫描；0.6.2 细化命令面板中的审查范围描述；0.6.3 把脱敏覆盖到全部运行产物，增加 finding 的 `direct`/`plan` 分区和结构化测试证据；0.6.4 把总报告改为按严重度排列并标注所属单元，同时生成 `graph.json` + `graph.html` 关系图；0.6.5 要求每条 finding 先写一句面向非开发者的“简述”，再接详细问题、证据、影响和修复；0.6.6 为每个单元标出核心必读文件，并要求专家声明实际读过的文件清单；0.6.7 让脱敏覆盖 `.bak`、临时脚本等全部常规文本产物，`latest` 只由最终 contract 通过的默认 `/logi` 报告发布，并要求模型删除自己创建的临时文件。设计记录见 [MODULE-DECISION.md](./MODULE-DECISION.md)。

## 核心交付物

每次审查的最终产品是 **`.logistics/runs/<runId>-master/report.md`**（单专家为 `<runId>-<expert>`）：它必须能独立交给用户阅读，包含项目总览、单元 × 专家覆盖矩阵、按严重度排列并标注所属单元的问题、证据、修复顺序与覆盖缺口。每个问题按 **简述 → 详细问题 → 证据 → 影响 → 修复** 展示：简述是一句给非开发者也看得懂的自然语言，详细问题保留原本的技术表述。`verdict.json` 只是机器判决，不能替代报告。

每位专家还会写一份自己的报告：`/logi` 在 `handoff/<expert>/<expert>.md`，单专家在 `handoff/<expert>.md`；总报告必须索引这些专家报告。报告缺失、过短或缺少关键章节时，`verdict.mjs` 会拒绝该次 run。

同一次运行还会生成 **`graph.json` + `graph.html`**：`graph.json` 是模块/问题/关系的机器可读图，`graph.html` 是自带 SVG、无需外部依赖的浏览器视图。关系由模型在 `verdict.relations` 中声明，插件负责校验 ID 并渲染。

报告把 finding 标成 `[可直接修]` 或 `[需方案]`，并分别给出 `## 可直接修` / `## 需方案` 清单；同时用 `## 测试证据` 逐条列出测试命令的 passed / failed / not-run。不要把“未跑测试”写成“测试通过”。

> **产物目录不要提交。** `.logistics/` 和 `docs/logistics/` 含完整报告和证据，可能包含源码片段；请把它们加入项目 `.gitignore`：
>
> ```gitignore
> .logistics/
> docs/logistics/
> ```
>
> 插件只能在扫描时忽略它们，不能替你保证不被 `git add -A` 提交。

## 它能做什么

- **审查整个项目**：用 `git ls-files` 收集受版本控制（以及未忽略）的源码、配置和构建文件，按模块切成最多 12 个审查单元；不再只看最后一次提交。
- **一份核心项目报告**：报告先给项目总览和「单元 × 专家」覆盖矩阵，再按 critical → high → medium → low 列出问题，每条标出所属单元（`[uXX]`）；哪个单元没覆盖、哪个专家失败，都会明确写出来。每位专家另有独立 Markdown 报告。
- **五个专家，按后果分工**：正确性、安全、健壮性（错误处理 + 测试）、可维护性（简化 + 清理）、性能（可选）。默认跑前四个。
- **证据优先**：问题必须有位置、证据、触发路径和影响；没有证据的严重问题会被降级，不会靠“感觉”报高优。
- **修复交给主模型**：报告中的每个 finding 都有稳定 ID 和 `kind`。需要修复时，把 `report.md` 或指定 ID 直接发给当前主会话模型；插件本身不执行写操作，也不维护独立 fixer。
- **关系图**：同一次运行生成 `graph.html`，把模块和问题画成模块分栏的 SVG；卡片显示简述，悬停可看详细问题、证据、影响和修复；`graph.json` 供其他工具消费。
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
dsh plugin --profile web add dsh-logistics@0.6.6   # 0.6.7 仍在源码中，尚未发布
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

所有审查命令都支持在命令后补充关注点：

```text
/logi 优先看鉴权、支付回调、数据库迁移和前端权限判断
```

需要修复时，请把报告或具体 finding ID 发给主模型；主模型会按报告中的位置、证据和修复步骤处理。插件不提供写操作命令；审查子代理仍受 prompt 约束。

每次审查（包括单专家命令）结束时，模型必须单独问一句：**“需要我帮你开始直接修复吗？还是你拿上报告去新开一个会话施行修复？”**

## 工作方式

```text
/logi-*
   │
   ├─ 1. 确定性事实（插件内 JS）
   │     git ls-files 全量清单、文件分类、模块归属、行数、
   │     审查单元划分、测试命令
   │     → .logistics/runs/<runId>-master/scope.json  # 单专家为 -<expert>
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
   └─ 6. 修复（可选，插件外）
         把 report.md 或指定 finding ID 交给主会话模型处理
```

关键约束：

- **一个专家一个 child，不是「单元 × 专家」几十个 child**。每位专家收到完整单元清单，必须逐单元给出覆盖状态；这样大型项目也只需要 4–5 个子代理，但报告能看出哪个单元被真正看过。
- 父代理每条消息最多派发 **4 个**子代理；一轮结束后等完成通知，再继续下一波。
- 缺失或非法 handoff 会重试一次；第二次失败写 `status: "failed"`，不会被当成“没问题”。
- 子代理 prompt 要求只读：不编辑源码、不提交、不删除、不嵌套子代理；当前没有独立的只读文件系统隔离。
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
- 每个单元带一份 `core` 核心必读清单（构建/配置、入口、认证/安全、迁移、路由/控制器/服务链路、最大文件，最多 12 个）；专家必须在 handoff 的 `units[].files` 列出实际读过的路径，至少 `project.minFilesPerUnit` 个（单元更小则全读），且覆盖全部 `core`。
- `project.maxFilesPerUnit` 控制单个单元的文件数，`project.maxUnits` 控制单元总数，`project.maxFiles` 控制总审查文件上限，`project.minFilesPerUnit` 控制每单元最低读文件数（默认 30）。
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
  graph.json             # 模块/问题/关系图（插件生成）
  graph.html             # 自带 SVG 的浏览器视图（插件生成）
```


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
    graph.json                # 模块/问题/关系图
    graph.html                # 自带 SVG 的浏览器视图
  latest.json
docs/logistics/latest.md      # 仅默认四模块完整时更新
```

报告包含：

- **项目总览**：项目根目录、HEAD、文件/单元/行数、本次覆盖的专家。
- **单元 × 专家覆盖矩阵**：每个单元被哪位专家标记为 reviewed / sampled / skipped；缺失和无效单独标出。
- **按严重度排序的问题**：critical → high → medium → low；每条标题前标注所属单元 `[uXX]`，并按“简述 → 详细问题 → 证据 → 影响 → 修复”展示；简述用非开发者也能看懂的一句话，详细问题保留技术表述。
- **未覆盖维度**：哪些单元只 sampled、哪些 skipped、哪些 handoff 失败/缺失。
- **建议修复顺序**：同文件合并、根因先行、可维护性单独批次、性能单独批次。
- **专家报告索引**：`/logi` 为 `handoff/<expert>/<expert>.md`，单专家为 `handoff/<expert>.md`；每位专家另有独立报告。
- **关系图**：`graph.html` 按模块分栏展示问题，栏内按严重度排列；卡片显示简述，鼠标悬停可查看详细问题、证据、影响和修复摘要；不画问题间连线。

`report.md` 是核心交付物；`verdict.mjs` 会检查它是否存在、长度、关键章节、是否出现全部单元 ID、finding 是否有 `file:line`、是否按“简述 → 详细问题 → 证据 → 影响 → 修复”展示、`direct`/`plan` 是否各自进入 `## 可直接修` / `## 需方案`、是否包含 `## 测试证据` 与全部测试命令、是否按严重度排序并标注单元，以及专家报告是否存在且被总报告索引。报告不达标时，该次 run 不能算完成，也不会更新 `latest`。

### 关系图

`graph.html` 由插件根据 `verdict.json` 确定性生成，不依赖 Graphviz、Mermaid 或任何外部 JS/CDN，直接用浏览器打开即可。图按模块分栏：每个模块是一栏，问题作为卡片放在所属模块栏内，因此“一对多”的模块归属由布局直接表达，不再画定位线；也不画问题之间的连线，避免大量卡片时线穿过正文。卡片显示模型写的一句话简述；鼠标悬停任意问题卡片，会显示详细问题、证据、影响和修复摘要。`graph.json` 的 `nodes` 分模块和问题两类，`edges` 保留 `located-in` 定位数据和模型关系，供机器消费。关系只连接本次 verdict 中真实存在的 finding ID；未知 ID、自环、重复边会被拒绝或忽略。

### 报告脱敏

`verdict.mjs` 在 contract 校验**之前**扫描整个 run 目录下的常规文本产物——`report.md`、每位专家的 `.json`/`.md`、`packet.md`、`handoffs.json`、`verdict.json`、`report.json`、`run.jsonl`、`scope.json`、`graph.json`、`.bak`/`.bak2`、临时 `.py`/`.sh` 和 `docs/logistics/latest.md`——把高置信度凭据替换成 `[REDACTED:<kind>]`，并在 `run.jsonl` 写入 `secrets.redacted` 事件。二进制文件不碰；无扩展名文件做 NUL 字节探测。覆盖私钥块、云厂商/平台 token、JWT、URL 内嵌密码、Basic/Bearer 认证和 `PASSWORD|SECRET|TOKEN|API_KEY=...` 赋值；`process.env.*`、`${...}`、`***` 等占位值不会误伤。

脱敏后 `lib/report-check.js` 还会做一次残留扫描；报告里仍有疑似凭据时，该次 run 直接判为不合格。**脱敏不等于风险消除**：如果报告曾经包含真实凭据，请轮换该凭据，并检查 `docs/logistics/latest.md`、`.logistics/` 是否被误提交。

子代理必须删除自己创建的临时文件（`*.bak`、`*.bak2`、`_repro_*`、临时脚本和调试输出）；`collect.mjs` 会列出 handoff 目录中的多余文件并警告。`latest` 只由 `verdict.mjs` 在最终报告和 verdict 都通过 contract 后发布，`aggregate.mjs` 不再写入 `latest`。

每个 finding 有稳定 ID，例如 `SEC-4F2A1`，并包含 `brief`（一句话简述）、`title`（详细问题）、证据、影响和修复。ID 由 `专家 | 类别 | 文件 | 归一化标题` 计算，**不含行号**；代码移动不会让同一个问题换 ID。跨专家报告同一根因时，由主编决定保留哪一条，其余写入 `verdict.json` 的 `dropped`。

`verdict.json` 的 schemaVersion 为 `2`，是稳定接口；`docs/logistics/latest.md` 与 `.logistics/latest.json` 只在**默认四模块完整覆盖**时更新，单模块或部分覆盖会保留上一份完整报告。

### 为什么没有健康分

不同模块的问题后果不同，用一个分数把它们相加会掩盖“安全阻断项”和“命名建议”的差别。报告改用：

- 严重度：`critical / high / medium / low / info`
- 可执行性：`direct`（机械、行为保持、可验证）或 `plan`（需要设计决策）
- 覆盖状态：单元级 reviewed / sampled / skipped；专家级完整 / 部分 / 失败 / 缺失

## 修复

插件不提供修复命令。审查结束后，报告里的 finding 已经包含位置、证据、影响和修复步骤；需要动手时，直接把 `report.md` 或指定 finding ID 发给当前主模型即可。

- 主模型按报告修复，受 DSH 当前的权限和审批策略约束；插件不会绕开这些约束。
- `direct` 表示问题定位明确、通常可以机械修复；`plan` 表示需要设计决策，不建议直接改。
- 修复前建议在干净分支或独立工作区操作，并先运行项目自己的测试命令。

## 配置

可选文件 `.logistics/config.json`：

```json
{
  "ignore": ["fixtures/**", "**/*.snap"],
  "maxFindingsPerPass": 12,
  "project": {
    "maxFiles": 2000,
    "maxFilesPerUnit": 120,
    "maxUnits": 12,
    "minFilesPerUnit": 30
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
- `project.minFilesPerUnit`：每个非 skipped 单元至少实际读过的文件数，默认 30；单元文件更少时按单元大小全读。不能大于 `maxFilesPerUnit`。
- `maxFindingsPerPass`：单个专家最多保留的问题数，默认 12；超过会被判无效，不会静默截断。
- `testCommand`：显式指定测试命令，会覆盖自动检测；为空时自动从根目录和一级子目录的 `package.json` / Maven / Gradle / `pytest` / `go` / `cargo` 推断，最多返回 8 条（例如前端 npm、后端 Maven、Python sidecar 各一条）。
- `modules`：模块显示名覆盖；不配置时按 `packages/*`、`apps/*`、去掉 `src`/`lib`/`app` 前缀后的首段推导。
- `models`：按专家指定 `provider` / `model` / 可选 `reasoningEffort`。只有 DSH 开启子代理模型选择且该路由被允许时才生效；否则自动回退到父会话模型，不会中断任务。

配置值非法时会回退到默认值并给出警告，不会让命令直接崩掉。

### 关于“要不要加 perf”

`/logi` 默认只跑四位专家：correctness / security / reliability / maintainability。它**不会自动追加**性能专家；需要性能审查时单独执行 `/logi-perf`，该命令同样覆盖整个项目。

`/logi` 的报告必须写“性能维度未运行，需要时执行 `/logi-perf`”，不能把未检查当成没问题。

## 适用边界

- **审查只读**：`/logi-*` 审查命令不会改源码；插件本身没有写操作命令。需要修复时由主模型按报告执行，受 DSH 权限与审批约束。
- **一位专家覆盖整个项目**：大型项目里专家会做跨文件模式扫描并抽样读关键文件，`handoff.units` 的 `sampled` / `skipped` 是诚实的覆盖声明；`sampled` 仍必须覆盖该单元全部 `core` 且达到最低读取数，不要把 `sampled` 当成逐行审查。
- **不是编译器**：静态分析基于专家判断；跨仓库、运行时才暴露的问题可能漏报。
- **部分覆盖不等于通过**：单专家报告仍然覆盖整个项目，但只代表该专家维度；报告会明确标出未覆盖单元和维度。
- **大型项目**：默认最多 2000 个文件、12 个单元、单专家 12 条问题；更大的仓库可调高 `project` 上限，或分目录建立多个 run。
- **性能需要证据**：`/logi-perf` 只报热路径，且性能项永远是 `plan`，不会自动改。

## 开发

```bash
npm test          # node --test，98 个测试（含全项目 scope、单元覆盖、核心文件/最低读取、报告契约、测试证据、脱敏、latest、端到端 contract 与运行日志）
npm run check     # 语法检查 + 全部测试
```

目录：

```text
lib/
  index.js        # DSH 入口：注册 5 个 skill、6 个命令
  commands.js     # 命令 handler：全项目 scope、派发、运行回复
  project.js      # 全项目文件分类、模块划分、审查单元
  scope.js        # git 清单、单元落盘、多模块测试命令、scope.json
  dispatch.js     # 主编/子代理 prompt、collect/bundle/verdict 命令
  handoffs.js     # handoff 校验、单元覆盖、专家报告、矩阵
  report-check.js # report.md 与专家报告的 contract 校验、残留凭据扫描
  graph.js        # graph.json + graph.html 关系图生成
  redact.js       # 全部运行文本产物（JSON/MD/log）的确定性脱敏与残留扫描
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
```

## License

MIT。迁移自 CodeCortexLoop；原项目与作者信息见 [LICENSE](./LICENSE) 与 git 历史。
