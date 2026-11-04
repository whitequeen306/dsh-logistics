# dsh-logistics

**项目后勤，为 DeepSeek Harness 而生。**

安装后获得一组 `/logi-*` 命令：先做确定性的范围收集，再让专家子代理按模块审查，最后由**你当前的主会话模型**担任主编，合并证据、定级、写模块化报告。机器只负责事实与 contract 校验，不替你打分或做质量裁决；报告里没有健康分，也不做基线门禁。每个问题都有稳定的 ID，你可以挑自己关心的 ID 交给 `/logi-fix` 执行，或先 `--dry-run` 看方案。

> 从 CodeCortexLoop（MIT，原仓库留存于 [master 分支](https://github.com/whitequeen306/dsh-logistics/tree/master)）迁移而来。0.2.0 起删除评分、基线与门禁；0.3.0 起改为「主编模型 + 薄机器层」，按专家可选模型路由。设计记录见 [MODULE-DECISION.md](./MODULE-DECISION.md)。

## 它能做什么

- **五个模块，按后果分工**：正确性、安全、健壮性（错误处理 + 测试）、可维护性（简化 + 清理）、性能（可选）。默认只跑前四个，性能按需开启。
- **按模块出报告**：报告按 `src`、`packages/api`、`apps/web` 等模块聚合，直接回答“哪个模块有什么问题、怎么修”。
- **证据优先**：问题必须有位置、证据、触发路径和影响；没有证据的严重问题会被降级，不会靠“感觉”报高优。
- **可选择修复**：报告中的 `direct` 项可以用 `/logi-fix <ID>` 交给一个串行 fixer；默认先出计划，真正执行前要求干净工作区、文件白名单、测试与失败回滚。
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
dsh plugin --profile web add dsh-logistics@0.3.1
dsh plugin --profile web add "C:/path/to/dsh-logistics"   # 本地开发
dsh --profile web --dump-config | grep -A2 dsh-logistics
```

> 0.3.0 起 npm 包是「主编模型 + 薄机器层」版本；0.3.1 补齐 handoff/verdict/fix contract 的验证漏洞。`dsh-logistics@0.1.0` 是旧的 7 专家/评分版本，不要与 0.2/0.3 的文档混用。skill 收敛为 6 个，不再有独立的 core/pipeline skill。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/logi` | 默认四模块：正确性、安全、健壮性、可维护性 |
| `/logi-correctness` | 只跑正确性模块 |
| `/logi-security` | 只跑安全模块 |
| `/logi-reliability` | 只跑健壮性模块（错误处理 + 测试） |
| `/logi-maintainability` | 只跑可维护性模块（简化 + 清理） |
| `/logi-perf` | 只跑性能模块（可选，默认不跑） |
| `/logi-fix` | 查看最近报告中的可执行修复项 |
| `/logi-fix <ID...>` | 执行指定 `direct` 修复项 |
| `/logi-fix --dry-run <ID...>` | 只出修复计划，不改源码 |

所有审查命令都支持在命令后补充关注点：

```text
/logi 只关注支付流程和退款状态机
```

`/logi-fix` 不支持 `--all`：一次只修你明确选择的 ID。`plan` 类型（需要设计决策）和性能项不会被自动执行。

## 工作方式

```text
/logi-*
   │
   ├─ 1. 确定性事实（插件内 JS）
   │     git 状态 / diff / 最近提交、忽略规则、文件清单、
   │     测试命令、模块归属、可选专家
   │     → .logistics/runs/<runId>/scope.json
   │
   ├─ 2. 注入派发消息（agent.followup）
   │     主会话模型成为「主编」：读 scope.json，
   │     默认派发 4 位专家；只有明确命中热路径时才追加 perf
   │
   ├─ 3. 子代理写 handoff
   │     .logistics/runs/<runId>/handoff/<expert>.json
   │
   ├─ 4. 主编裁决（主会话模型）
   │     collect.mjs 收集完整性；bundle.mjs 生成候选材料
   │     模型自己合并/去重/定级/取舍，写 verdict.json + report.md
   │     verdict.mjs 只校验 contract，不判断内容好坏
   │
   └─ 5. 修复（可选）
         /logi-fix 从最近一份完整 verdict.json 读取 direct 项
```

- 父代理每条消息最多派发 **4 个**子代理；一轮结束后等完成通知，再继续下一波。
- 缺失或非法 handoff 会重试一次；第二次失败写 `status: "failed"`，不会被当成“没问题”。
- 子代理只读：不编辑源码、不提交、不删除、不嵌套子代理。
- 没有 `subagent` 工具时**不会**退化成父代理自己审：直接报告限制并停止，避免把单会话猜测包装成专家结论。
- 机器不生成最终报告，也不做质量门禁；`collect.mjs` 的 `complete` 只表示“证据收齐”，不表示“审查通过”。

## 报告

```text
.logistics/
  runs/<runId>/
    scope.json
    handoff/<expert>.json
    handoffs.json             # bundle 生成的候选材料索引
    packet.md                 # 给主编的候选材料
    verdict.json              # 主编裁决（机器只校验 contract）
    report.md                 # 人读的模块化报告
  latest.json
  fixes/<fixRunId>/
    selection.json
    fix.json
    fix-reverted.patch        # 仅失败回滚时出现
docs/logistics/latest.md      # 仅默认四模块完整时更新
```

报告包含：

- **模块总览**：模块、涉及专家、各严重度数量、最严重问题。
- **按模块分组的问题**：标题、位置、证据、影响、修复步骤、涉及文件、建议测试。
- **未覆盖维度**：哪些模块没跑、handoff 失败 / 缺失 / 部分完成。
- **建议修复顺序**：同文件合并、根因先行、可维护性单独批次、性能单独批次。

每个 finding 有稳定 ID，例如 `COR-4F2A1`。ID 由 `专家 | 类别 | 文件 | 归一化标题` 计算，**不含行号**；代码移动不会让同一个问题换 ID。跨专家报告同一根因时，由主编决定保留哪一条，其余写入 `verdict.json` 的 `dropped`。

`verdict.json` 的 schemaVersion 为 `2`，是稳定接口；`docs/logistics/latest.md` 与 `.logistics/latest.json` 只在**默认四模块完整覆盖**时更新，单模块或部分覆盖会保留上一份完整报告。

### 为什么没有健康分

0.2.0 明确删除了评分、基线与门禁。不同模块的问题后果不同，用一个分数把它们相加会掩盖“安全阻断项”和“命名建议”的差别。报告改用：

- 严重度：`critical / high / medium / low / info`
- 可执行性：`direct`（机械、行为保持、可验证）或 `plan`（需要设计决策）
- 覆盖状态：完整 / 部分 / 失败 / 缺失

## 修复

`/logi-fix` 是唯一的写操作入口，默认安全优先：

1. **列出**：不带参数时，只列出最近一份完整 `verdict.json` 中的 `direct` ID，不改任何文件。
2. **计划**：`--dry-run <ID...>` 输出每个 ID 的位置、白名单文件、测试和步骤。
3. **执行**：带 ID 且不带 `--dry-run` 时，要求：
   - 最近 `verdict.json` 通过 contract 校验、`schemaVersion = 2` 且覆盖完整；
   - git 仓库、工作区没有未提交的源码改动；
   - 判决生成后 HEAD 未变化（否则证据可能过期）；
   - ID 存在、`kind = direct`、不属于性能模块。
4. 通过后创建 `.logistics/fixes/<fixRunId>/selection.json`，派发**一个** fixer 子代理。
5. fixer 只改白名单文件，跑 `scope.testCommand`；失败时保存 `fix-reverted.patch`、回滚该组改动，并在 `fix.json` 标记 `failed` / `partial`。
6. 不会自动 commit、push、安装依赖或联网。

> 审查阶段仍然只读。`/logi-fix` 不会复用审查子代理，也不会让多个专家并行改代码。

## 配置

可选文件 `.logistics/config.json`：

```json
{
  "ignore": ["fixtures/**", "**/*.snap"],
  "maxFiles": 400,
  "maxFindingsPerPass": 12,
  "includeLastCommitWhenClean": true,
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
- `maxFiles`：送入审查的文件上限；超出时会截断并给出警告。
- `maxFindingsPerPass`：单个专家最多保留的问题数。
- `includeLastCommitWhenClean`：工作区干净时审查最近一次提交，而不是直接空跑。
- `testCommand`：fixer 使用的测试命令；为空时自动从 `package.json` / `vitest` / `jest` / `pytest` / `go` / `cargo` 推断。
- `modules`：模块显示名覆盖；不配置时按 `packages/*`、`apps/*`、去掉 `src`/`lib`/`app` 前缀后的首段推导。
- `models`：按专家指定 `provider` / `model` / 可选 `reasoningEffort`。只有 DSH 开启子代理模型选择且该路由被允许时才生效；否则自动回退到父会话模型，不会中断任务。

配置值非法时会回退到默认值并给出警告，不会让命令直接崩掉。

### 关于“要不要加 perf”

`scope.json` 只记录事实：改了哪些文件、多少行、什么语言、测试命令。是否追加性能专家是**主会话模型的判断**，不是机器风险分：

- 默认跑四位：correctness / security / reliability / maintainability。
- 只有 diff 明确涉及热路径（数据库查询或索引、请求链路、渲染循环、大列表、缓存/序列化、启动路径）时才追加 `perf`。
- 不追加时，报告必须写“性能未覆盖”，不能把未检查当成没问题。

## 适用边界

- **审查只读**：`/logi-*` 审查命令不会改源码；只有 `/logi-fix` 且显式给 ID 时才写文件。
- **不是编译器**：静态分析基于改动上下文和专家判断；跨仓库、运行时才暴露的问题可能漏报。
- **部分覆盖不等于通过**：单模块报告只代表该模块，报告会明确标出未覆盖维度。
- **大改动**：默认最多 400 个文件、单专家 12 条问题；超大 PR 建议拆分或提高上限后重跑。
- **性能需要证据**：`/logi-perf` 只报热路径，且性能项永远是 `plan`，不会自动改。

## 开发

```bash
npm test          # node --test，59 个测试（含端到端 contract 冒烟）
npm run check     # 语法检查 + 全部测试
```

目录：

```text
lib/
  index.js        # DSH 入口：注册 6 个 skill、7 个命令
  commands.js     # 命令 handler：scope、派发、/logi-fix
  scope.js        # git/文件范围、忽略、测试命令、scope.json
  dispatch.js     # 主编/子代理 prompt、collect/bundle/verdict 命令
  handoffs.js     # handoff 校验、候选材料、重复提示
  verdict.js      # 主编裁决 contract 校验
  report.js       # 旧版聚合器（保留给兼容/测试）
  findings.js     # 归一化、稳定 ID、模块归属、排序
  config.js       # .logistics/config.json
  constants.js    # 5 个模块、severity、默认配置
  util.js         # 零依赖工具
  cli/            # collect.mjs / bundle.mjs / verdict.mjs
skills/           # 5 个专家 + fix
test/             # node:test 与临时 git 仓库夹具
cordis.patch.yml  # DSH bundle patch
```

设计取舍：

- **不 import `@deepseek-ai/*`**：官方包由 DSH 宿主提供，插件不重复安装，避免版本线冲突。
- **薄机器层**：机器只做范围、handoff 收集、contract 校验、ID 与安全边界；质量判断和成文交给主会话模型。
- **主编模型**：默认主会话模型担任 editor-in-chief，可读原始 handoff、合并/丢弃、定级；不把“机器去重结果”当成最终结论。
- **单包 + 清晰分层**：当前规模不值得拆成多个 npm 包；模块边界体现在 `lib/`、`skills/` 和文档中的执行方法上。

## 许可

MIT。见 [LICENSE](./LICENSE)。

原始项目 [CodeCortexLoop（原仓库 master 分支）](https://github.com/whitequeen306/dsh-logistics/tree/master) 亦为 MIT；本项目的命令命名、编排协议、报告格式与 DSH 集成已重写，领域检查清单与模块划分参考原项目。
