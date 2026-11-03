# dsh-logistics

**项目后勤，为 DeepSeek Harness 而生。**

安装后获得一组 `/logi-*` 命令：一条命令完成范围收集、专家子代理调度、结果聚合、健康分与基线门禁。它不修改源码，只做只读审查与报告。

> 从 [CodeCortexLoop](https://github.com/whitequeen306/code-cortex-loop)（MIT）迁移而来。命令、编排与报告格式已针对 DSH 重写；领域知识保留在 10 个 skill 中。

## 它能做什么

- **按风险花 token**：`/logi` 先看改动范围，再决定快速 / 标准 / 全量档。
- **专家分工**：正确性、安全、测试、错误处理、性能、简化、清理，7 位专家各看各的，减少"什么都查一点"的泛泛而谈。
- **证据优先**：问题必须有位置、证据、触发路径和影响；没有证据的严重问题会被降级。
- **可比较**：健康分、JSON/Markdown 报告、按指纹比较的基线，适合在 PR 前后看趋势。
- **DSH 原生**：命令由插件注册，专家通过内置 `subagent` 工具拉起；不依赖外部脚本运行时，也没有 npm 依赖。

## 安装

要求：DeepSeek Harness `0.2.1` 或更新版本，Node.js `^22.19.0 || >=24.0.0`。

从本地目录安装（路径用绝对路径）：

```bash
dsh plugin --profile desktop add "C:/path/to/dsh-logistics"
```

发布到 npm 后也可以：

```bash
dsh plugin add dsh-logistics
```

安装后重启 / 刷新 DSH，输入 `/logi` 应能看到命令补全。检查配置：

```bash
dsh --profile desktop --dump-config | grep -A2 dsh-logistics
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/logi` | 自动档：评估风险，选择快速 / 标准 / 全量，并调度专家 |
| `/logi-quick` | 快速档（3 位）：正确性、安全、错误处理 |
| `/logi-standard` | 标准档（5 位）：快速档 + 测试、清理 |
| `/logi-full` | 全量档（7 位）：全部专家 |
| `/logi-review` | 单专家：正确性审查 |
| `/logi-safety` | 单专家：安全审查 |
| `/logi-tests` | 单专家：测试审查 |
| `/logi-errors` | 单专家：错误处理审查 |
| `/logi-perf` | 单专家：性能审查 |
| `/logi-simplify` | 单专家：简化审查（保持行为不变） |
| `/logi-cleanup` | 单专家：死代码、未用依赖、孤立文件 |
| `/logi-gate` | 基线门禁：检查最近报告；`/logi-gate accept` 接受最近一次全量报告为基线 |

所有命令都支持在命令后补充关注点，例如：

```text
/logi-standard 只关注支付流程和退款状态机
```

单专家命令与档位命令共用同一套报告 / 基线体系，但单专家报告会被标记为**部分覆盖**，门禁退出码为 `3`（不确定），不会误判为通过。

## 工作方式

```text
/logi-* 命令
   │
   ├─ 1. 确定性预检（插件内 JS）
   │     git 状态 / diff / 最近提交、忽略规则、文件清单、
   │     测试命令、风险等级、档位与专家列表
   │     → .logistics/runs/<runId>/scope.json
   │
   ├─ 2. 注入派发消息（agent.followup）
   │     父代理加载 logi-core / logi-pipeline skill，
   │     用内置 subagent 工具为每位专家启动一个只读子代理
   │
   ├─ 3. 子代理写 handoff
   │     .logistics/runs/<runId>/handoff/<pass>.json
   │
   └─ 4. 聚合（插件内 CLI）
         归一化、去重、计分、基线比较、门禁
         → .logistics/runs/<runId>/report.{json,md}
         → docs/logistics/latest.md
         → .logistics/latest.json
```

- 父代理最多同时派发 **4 个**子代理；一轮结束后等完成通知，再检查 handoff。
- 缺失或非法 handoff 会重试一次；第二次失败则写 `status: "failed"`，不会被当成"没问题"。
- 子代理只读：不编辑源码、不提交、不删除、不嵌套子代理。
- 若当前 DSH 没有可用的 `subagent` 工具，会退化为单会话的 `logi-review` + `logi-safety` 两段式审查，并明确说明是降级结果。

## 报告

每次运行写入：

```text
.logistics/
  runs/<runId>/
    scope.json
    handoff/<pass>.json
    report.json
    report.md
  latest.json
  baseline.json          # /logi-gate accept 后出现
docs/logistics/latest.md # 最近一次报告，便于提交 / 分享
```

报告包含：范围概览、专家完成情况、按严重度排序的问题、健康分、基线新增 / 已修复 / 剩余、门禁结论。`report.json` 是稳定接口，适合接 CI 或其他工具。

### 健康分

从 100 分开始，按**去重后的最严重问题**扣分：

| 严重度 | 扣分 |
| --- | ---: |
| Critical | 25 |
| High | 10 |
| Medium | 4 |
| Low | 1 |
| Info | 0 |

等级：A ≥ 90，B ≥ 80，C ≥ 70，D ≥ 60，F < 60。分数最低为 0。

### 基线门禁

`/logi-gate` 不启动子代理，只比较最近报告与 `.logistics/baseline.json`：

| 退出码 | 含义 |
| --- | --- |
| `0` | 通过：没有新增 Critical；未超过配置的高危 / 分数下降阈值 |
| `1` | 新增 Critical |
| `2` | 新增 High（`gate.failOnNewHigh: true` 时），或分数下降超过 `maxScoreDrop` |
| `3` | 覆盖不完整 / 报告过期 / 无基线，结论不确定 |

`/logi-gate accept` 只接受**覆盖完整**且对应代码状态未变化的最近报告；之后旧问题不再算"新增"。指纹刻意不包含行号：`sha1(pass | category | file | ruleId | 归一化标题)`，这样 rebase / 移位不会把旧债变成新债。

## 配置

可选文件 `.logistics/config.json`：

```json
{
  "ignore": ["fixtures/**", "**/*.snap"],
  "maxFiles": 400,
  "maxFindingsPerPass": 12,
  "includeLastCommitWhenClean": true,
  "gate": {
    "failOnNewHigh": false,
    "maxScoreDrop": 5
  }
}
```

- `ignore` 会追加在内置忽略规则之后（`node_modules`、`dist`、锁文件等始终忽略）。
- `maxFiles`：送入审查的文件上限；超出时会截断并给出警告。
- `maxFindingsPerPass`：单个专家最多保留的问题数。
- `includeLastCommitWhenClean`：工作区干净时审查最近一次提交，而不是直接空跑。
- `gate.failOnNewHigh`：是否把"新增 High"也判为失败。
- `gate.maxScoreDrop`：允许的分数下降幅度；仅在全量基线与全量报告之间比较。

配置值非法时会回退到默认值并给出警告，不会让命令直接崩掉。

## 适用边界

- **只读**：这是审查工具，不会自动修复、删除死代码或升级依赖；清理建议需要人工确认。
- **不是编译器**：静态分析基于改动上下文和专家判断；跨仓库、运行时才暴露的问题可能漏报。
- **部分覆盖不等于通过**：单专家 / 快速档报告的门禁结论是"不确定"。
- **大改动**：默认最多 400 个文件、单专家 12 条问题；超大 PR 建议拆分或提高上限后重跑。

## 开发

```bash
npm test          # node --test，零依赖
npm run check     # 语法检查 + 全部测试
```

目录：

```text
lib/              # 插件入口、命令、范围、报告、基线、派发
lib/cli/          # status / aggregate / gate 离线 CLI
skills/           # 10 个 skill：core、pipeline、7 位专家、gate
test/             # node:test 测试与临时 git 仓库夹具
cordis.patch.yml  # DSH bundle patch
```

设计取舍：

- **不 import `@deepseek-ai/*`**：官方包由 DSH 宿主提供，插件不重复安装，避免版本线冲突。
- **命令只做确定性工作**：收集范围、建 run、注入派发消息；LLM 编排交给 skill + `subagent`，这样 UI 能看到子代理，失败也可见。
- **聚合放在插件里**：计分、去重、基线、报告格式不依赖模型发挥，保证可重复。

## 许可

MIT。见 [LICENSE](./LICENSE)。

原始项目 [CodeCortexLoop](https://github.com/whitequeen306/code-cortex-loop) 亦为 MIT；本项目的命令命名、编排协议、报告格式与 DSH 集成已重写，领域检查清单与评分思想来自原项目。
