# 后勤模块最终决策

> 状态：**最终版**（独立子代理复核后定稿）。
>
> 目标：把 0.1.0 的 7 位专家、12 个命令、健康分/基线/门禁，收敛成 **5 个模块 / 默认 4 个专家 / 7 个命令 / 模块化报告 / 用户选择修复** 的 0.2.0。

## 1. 最终结论

保留 **5 个后勤模块**，默认运行其中 **4 个**；性能独立为可选模块。

| key | 中文名 | 职责 | 命令 | skill | 默认 |
| --- | --- | --- | --- | --- | --- |
| `correctness` | 正确性 | 逻辑、状态、并发、数据完整性、接口契约、边界条件、schema 迁移、公开 API 破坏性变更 | `/logi-correctness` | `logi-correctness` | 是 |
| `security` | 安全 | 认证、授权/租户、注入、密钥、加密、上传/SSRF、数据暴露、依赖与供应链 | `/logi-security` | `logi-security` | 是 |
| `reliability` | 健壮性 | ①错误处理 ②测试缺口；报告内分两个子节 | `/logi-reliability` | `logi-reliability` | 是 |
| `maintainability` | 可维护性 | ①简化 ②清理；报告内分两个子节 | `/logi-maintainability` | `logi-maintainability` | 是 |
| `perf` | 性能 | 热路径、复杂度、N+1、阻塞 I/O、内存、缓存 | `/logi-perf` | `logi-perf` | 否 |

- `/logi` 默认运行 `correctness`、`security`、`reliability`、`maintainability` 四位专家。
- `perf` 只通过 `/logi-perf` 单独运行；`/logi` 报告里必须明确写“性能维度未运行”，不能假装已覆盖。
- 不再有健康分、grade、baseline、gate、CI 门禁、quick/standard/full 三档。

## 2. 复核依据

### 2.1 现在 7 个专家“计分上等价”，但后果不等价

当前 `lib/constants.js:14-20` 只有 severity 权重，没有 per-pass 权重；`lib/report.js:412-443` 的计分也只按 finding 严重度扣分。所以 7 个专家在分数上完全等价，但实际后果分四层：

1. **阻断层**：`correctness`、`security`——出问题直接是 bug 或漏洞；
2. **健壮层**：`reliability`——决定失败会不会被掩盖、会不会回归；
3. **建议层**：`maintainability`——`logi-simplify:119-128`、`logi-cleanup:127-134` 已把严重度封顶在 medium；
4. **条件层**：`perf`——需要热路径证据，默认跑容易产生噪音。

这就是“4 个默认 + 1 个可选”的依据，而不是把 7 个专家平均保留。

### 2.2 现有档位本身自相矛盾

`lib/constants.js:98-114`：

- `quick` 有 `errors`、没有 `tests`；
- `standard` 有 `cleanup`、没有 `simplify`；
- `full` 才 7 个全上。

新默认 4 位专家覆盖 6/7 个领域（含 simplify），比今天 `standard` 的 5 位专家覆盖 5/7 更完整；`perf` 本来就不在 quick/standard，设为可选不是倒退。

### 2.3 合并的强弱

| 合并 | 判断 | 理由 | 防线 |
| --- | --- | --- | --- |
| `errors` + `tests` → `reliability` | **成立，但最弱** | 两者都在问“失败时怎样、会不会回归”，但证据对象和输出格式不同（`logi-tests:99-118` 的 Gap/Current/Proposed/Why 必须保留） | 强制两个子节；handoff 声明 sections；机器校验；连续两次缺失就拆回 5 个默认专家 |
| `simplify` + `cleanup` → `maintainability` | **成立** | 都以“不改变行为”为前提，都是长期维护成本 | cleanup 收窄；保留 CONFIRMED/LIKELY/UNCERTAIN → confidence 映射 |
| `security` 并入 `correctness` | **不成立** | 攻击者模型、可达性、后果不同；混在一起会被“功能对不对”稀释 | 安全独立 |
| `tests` 并入 `correctness` | **不成立** | `logi-review` 已经 182 行、是最大 skill；测试审查输出是“缺哪个测试”，不是“逻辑错在哪” | 归入 reliability |
| `perf` 并入 `maintainability` | **不成立** | 性能是运行时行为，简化是代码结构 | perf 独立可选 |

### 2.4 cleanup 必须收窄

`logi-cleanup:140` 自己承认“本地未用 import”是噪音，linter 更擅长。新 `maintainability` 的 cleanup 子节只报：

- 未使用依赖 / lockfile 债务；
- 孤儿文件；
- 公开面死代码（有 grep 证明、确认无外部引用）；
- 不报本地未用 import，不报纯风格问题。

### 2.5 不新增第 6 个专家

- 架构边界、API 兼容、schema 迁移 → 并入 `correctness`；
- 可观测性 → 并入 `reliability`；
- 文档缺失 → `maintainability` 里最多一条 `info`；
- 不为了“看起来完整”再加一个 architecture 专家。

## 3. 命令集

| 命令 | 作用 |
| --- | --- |
| `/logi` | 全量模块化报告（正确性、安全、健壮性、可维护性） |
| `/logi-correctness` | 只跑正确性 |
| `/logi-security` | 只跑安全 |
| `/logi-reliability` | 只跑错误处理 + 测试 |
| `/logi-maintainability` | 只跑简化 + 清理 |
| `/logi-perf` | 只跑性能（可选） |
| `/logi-fix` | 查看/执行最近报告中的修复项 |

**命令名必须与 key / skill 对齐**：不再保留 `/logi-review`、`/logi-safety`。父方案里 key 叫 `correctness`/`security`，命令却叫 `review`/`safety`，会出现四套名字互译；`/logi-review` 还和 `/logi` 语义撞车。统一为 `correctness`/`security`。

删除：

- `/logi-quick`、`/logi-standard`、`/logi-full`：不再分档；
- `/logi-tests`、`/logi-errors`、`/logi-simplify`、`/logi-cleanup`：并入 reliability / maintainability；
- `/logi-gate`：不再有 baseline/gate。

不注册废弃命令兼容壳；0.2.0 是 breaking change，在 CHANGELOG 给映射表。

## 4. 报告规范

### 4.1 模块必须由 JS 确定性推导

**不许子代理自己起模块名**（违反 `ARCHITECTURE.md:20` 的分层原则）。聚合器统一计算：

- `packages/<name>/...` → `packages/<name>`；
- `apps/<name>/...` → `apps/<name>`；
- 其余路径先去掉公共根 `src/`、`lib/`、`app/`、`apps/`，再取首段：`src/auth/login.ts` → `auth`；
- 根目录文件 → `(root)`；
- 跨模块依赖/配置问题 → `dependencies` 或 `(repo)`；
- 允许 `.logistics/config.json` 的 `modules` 字段提供显示名映射，但归属仍由 JS 决定。

### 4.2 报告骨架

```markdown
# 项目后勤报告 · <repo> · 2026-11-03

一句话结论：本次发现 3 个高优先级问题，集中在 auth 和 api 模块。

## 模块总览

| 模块 | 严重 | 高 | 中 | 低 | 专家 |
| --- | ---: | ---: | ---: | ---: | --- |
| auth | 0 | 2 | 1 | 0 | correctness, security |
| api  | 0 | 1 | 0 | 1 | reliability |

## 模块 auth

### [高] 登录失败会吞掉原始异常
- ID: REL-3F2A9
- 位置: src/auth/login.ts:42
- 证据: ...
- 影响: ...
- 修复:
  1. ...
  2. ...
- 涉及文件: ...
- 建议测试: ...
- 类型: direct（可直接修） / plan（需要方案确认）

## 模块 api

...

## 未发现问题的模块

- `utils`：已检查，未发现需要报告的问题。

## 未覆盖维度

- 性能：本次未运行（需要时执行 `/logi-perf`）。
- 测试：reliability 已覆盖；无失败 handoff。

## 建议修复顺序

1. REL-3F2A9（高，安全相邻，先修）
2. COR-8B1D0（高，同文件，合并修复）
3. MNT-1C7E2（中，单独批次，避免行号漂移）
```

报告不再有健康分、grade、baseline 新增/存量、gate exit code、计分说明。

### 4.3 finding 字段

```json
{
  "id": "REL-3F2A9",
  "module": "auth",
  "section": "error-handling",
  "expert": "reliability",
  "category": "error-handling",
  "severity": "high",
  "confidence": "high",
  "title": "登录失败会吞掉原始异常",
  "file": "src/auth/login.ts",
  "line": 42,
  "evidence": "catch 块只返回 null，没有日志或错误码",
  "impact": "上游无法区分密码错误和数据库故障",
  "kind": "direct",
  "fix": {
    "summary": "保留原始 error，返回稳定错误码",
    "steps": [
      "把原始 error 作为 cause 保留",
      "返回 AuthError 的稳定错误码",
      "补一个数据库失败用例"
    ],
    "files": ["src/auth/login.ts", "src/auth/errors.ts"],
    "tests": ["数据库异常时返回 AUTH_BACKEND_UNAVAILABLE"]
  }
}
```

- **删除 `ruleId`**：`report.js:128-131` 只是“前缀-类别”，必然重复，没有信息量。
- **删除 `autoFixable`**：`ARCHITECTURE.md:324` 已承认是空承诺；改用 `kind: direct | plan`。
  - `direct`：可在选中文件内直接改代码；
  - `plan`：需要设计/迁移方案，`/logi-fix` 拒绝执行，只作为人工计划。
- `fix.steps` 要求 3–6 步；`fix.tests` 至少一条，或明确“无法自动测”。
- `section` 用于合并模块：reliability 的 `error-handling` / `tests`，maintainability 的 `simplify` / `cleanup`。

### 4.4 稳定 ID

```text
<PREFIX>-<sha1(pass|category|file|normalizeTitle(title)).slice(0,5).toUpperCase()>
```

- 不含行号，避免行号漂移导致 ID 变化；
- 同一次 run 内碰撞则扩到 6 位；
- 需要 `baseline.js:17-37` 的 `normalizeTitle`/`fingerprint`，所以删除 `baseline.js` 前必须先搬到 `lib/findings.js`；
- ID 只用于报告选择和修复定位，不再做 baseline 比较。

### 4.5 排序

- **报告内**：severity 主序；同级固定 tiebreak：`security > correctness > reliability > maintainability > perf`；这不是权重系数，只是排序规则。
- **建议修复顺序**：按可执行性排——同文件合并、根因先行、`maintainability` 单独批次（避免行号漂移作废证据）、`perf` 单独批次。

## 5. 修复流程

### 5.1 查看

```text
/logi-fix
```

只列最近报告里 `kind=direct` 的 ID、标题、严重度、涉及文件；`plan` 项只提示“需要人工方案”。

### 5.2 dry-run

```text
/logi-fix --dry-run REL-3F2A9 COR-8B1D0
```

只输出编辑计划（文件、步骤、测试），不写源码；**拒绝 apply-then-revert**；隔离 worktree 留到 0.3。

### 5.3 执行

```text
/logi-fix REL-3F2A9 COR-8B1D0
```

前置硬失败：

- 报告必须 `schemaVersion: 2`；
- HEAD 未变（复用 `commands.js:166-177` 的 stale 判断，不删）；
- git 无 tracked 修改（生成物除外）；
- 非 git 仓库拒绝；
- ID 必须存在、`kind=direct`；`perf`/`plan` 拒绝；
- 不支持 `--all`。

执行步骤：

1. 快照当前 `git status` + diff hash；
2. 派**一个** fixer 子代理，加载 `logi-fix` skill；给文件白名单，不 commit、不装依赖、越界即停；
3. 校验实际改动集合 ⊆ 白名单；
4. 跑 `scope.testCommand`；没有测试命令则明确标“未验证”；
5. 逐 ID 写 `fix.json`（`fixed` / `partial` / `failed`）；
6. 失败先保存 `fix-reverted.patch`，再 `git checkout` 回滚并删除新建文件；
7. 不 commit；输出修改摘要、测试结果、未完成项。

### 5.4 只读守卫

- 审查阶段：派发前记录 `git status` + diff hash，聚合前复算；发现源码变化则写“证据可能过期”警告，不静默通过。
- 修复阶段：同样复算，源码变化直接硬停。
- 生成物 `.logistics/`、`docs/logistics/` 不计入源码变化。

## 6. 删除与迁移清单

删除：

- `skills/logi-tests/`、`skills/logi-errors/`、`skills/logi-simplify/`、`skills/logi-cleanup/`、`skills/logi-gate/`；
- `lib/baseline.js`（先把 `normalizeTitle`/`fingerprint` 搬到 `lib/findings.js`）；
- `lib/cli/gate.mjs`。

重命名：

- `skills/logi-review/` → `skills/logi-correctness/`；
- `skills/logi-safety/` → `skills/logi-security/`。

删除概念/代码：

- `SEVERITIES.*.weight`、`computeScore`、`grade`、`score` 字段；
- `TIERS`、`SINGLE_TIER`、`MODES`、`tier`/`mode`/`risk.recommendTier`；
- `baseline`、`gate`、`coverage.percent`；
- `autoFixable`、`ruleId`。

改写：

- `lib/report.js`：按模块聚合、跨专家去重、短 ID、新 Markdown；
- `lib/commands.js`：7 个命令 + fix handler，删 `runGate`/gate 文案；
- `lib/dispatch.js`：报告派发、单专家派发、fix 派发；
- `lib/constants.js`：5 个专家、无 tiers、无 gate 配置；
- `lib/scope.js`：`experts` 替代 `passes`，去掉 risk/tier；
- `lib/index.js:60`：去掉硬编码 12；
- `skills/logi-core`：finding 增加 `kind`/`fix`，去掉分数/基线措辞；
- `skills/logi-pipeline`：4 位默认专家、模块报告；
- 新增 `skills/logi-correctness`、`logi-security`、`logi-reliability`、`logi-maintainability`、`logi-fix`；
- README / ARCHITECTURE / CHANGELOG / tests 同步；版本 0.2.0。

测试改动：

- `test/skills.test.js:11-16/:45/:52`；
- `test/commands.test.js:34-49/:51-78/:113-136`；
- `test/report.test.js:6-7/:65`；
- `test/cli.test.js:28`；
- 新增 `test/findings.test.js`、`test/fix.test.js`。

## 7. 相对父方案的四个必须修正

1. **命令名与 key 对齐**：`/logi-correctness`、`/logi-security`，不要 `/logi-review`、`/logi-safety`。
2. **跨专家去重必须从 `computeScore` 里救出来**：`report.js:412-421` 是当前唯一去重点；删分数时如果直接删掉，同一缺陷会被两个专家各报一次。去重逻辑移到 `lib/findings.js`。
3. **堵住空 handoff 放行**：`status.mjs:29` 与 `report.js:188` 只校验 findings 是数组，空 summary + 空数组算 ok；没有分数后会被报告写成“该模块未发现问题”，是最严重假阴性。要求 summary 非空、sections 声明、缺 section 重试。
4. **`autoFixable` → `kind: direct | plan`**，并收窄 cleanup 范围。

## 8. 风险与取舍

1. **可靠性合并最弱**：测试半边可能被跳过。防线：sections 声明 + 机器校验 + 连续两次缺失拆回 5 个默认专家。
2. **模块是展示层，不是架构边界**：按路径分组可能拆开强关联模块。防线：finding 保留 `file`，支持 `relatedFiles`；模块只影响报告阅读，不影响证据。
3. **直接修复仍有风险**：fixer 可能改错。防线：干净工作区、文件白名单、测试、失败回滚、越界检查、不提交。
4. **删除 baseline/gate 是 breaking change**：已有 CI 用户会受影响。0.2.0 明确 breaking；以后需要再加独立 `--fail-on`，不恢复整套 baseline。
5. **性能可选可能被遗忘**：报告必须显式写“性能未运行”；README 说明 `/logi-perf`。

## 9. 实施顺序

1. 新建 `lib/findings.js`，搬 `normalizeTitle`/`fingerprint`，加去重与短 ID；
2. 改 `constants.js`（5 专家、无 tiers/weights/gate）；
3. 改 `scope.js`（experts、去 risk/tier）；
4. 改 `report.js`（模块聚合、新 Markdown、空 handoff 校验）；
5. 改 `commands.js` / `dispatch.js`（7 命令 + fix）；
6. 合并/重命名 skills；
7. 改测试、README、ARCHITECTURE、CHANGELOG；
8. 本地 `node --check` + `npm test`；
9. 0.2.0 发布前用临时 profile 验证命令注册。

## 10. 最终建议

**就按这个定：5 个模块、默认 4 个、7 个命令、报告按模块、无分数、无 baseline/gate、`/logi-fix` 按 ID 单 fixer 执行。**

这是破坏性变更，但能把 0.1.0 的“审查流水线 + 计分系统”收敛成用户真正要的“项目后勤报告 + 选择性修复”。如果只能先做一条，优先做 **跨专家去重**——它直接决定报告可信度；命令重命名可以放到 0.2.1，但既然要 breaking，建议一次做完。
