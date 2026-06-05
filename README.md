# YoungFlow

通用 AI flow runner。[LangGraph](https://github.com/langchain-ai/langgraph) 编排多阶段 agent 流水线，[pi](https://github.com/badlogic/pi-mono/) CLI 执行每个任务。

项目本身不绑定任何特定 flow——flow 作为独立资产包传入，引擎只负责调度。

## 快速开始

```bash
# 安装
npm install

# 编译
npm run build

# 全局链接（可选，注册 youngflow 命令）
npm link

# 查看 flow 结构
youngflow flows/vulnhunt/flow.yaml --list-stages

# 执行（CLI 参数由 flow.yaml inputs 动态生成）
youngflow flows/vulnhunt/flow.yaml \
  --work-dir /path/to/project \
  --output-dir ./output

# 只跑到某个阶段
youngflow flows/vulnhunt/flow.yaml \
  --work-dir /path/to/project --until profiler

# 断点恢复
youngflow flows/vulnhunt/flow.yaml \
  --output-dir ./output --resume

# 基于已有业务产物开启新一轮（归档旧 .youngflow 引擎态，不复用 pi session/context）
youngflow flows/vulnhunt/flow.yaml \
  --work-dir /path/to/project \
  --output-dir ./output --continue

# 提高 LangGraph engine step budget（loop-heavy flows）
youngflow flows/vulnhunt/flow.yaml \
  --work-dir /path/to/project \
  --output-dir ./output --recursion-limit 200
```

## 架构

### 模块依赖（只能向下，不能向上）

```
┌──────────────────────────────────────────────────────────┐
│  CLI                cli.ts                               │
│                     参数解析（从 flow.yaml inputs 动态生成）│
├──────────────────────────────────────────────────────────┤
│  Spec               spec.ts                              │
│                     flow.yaml → readonly types            │
│                     flow.schema.yaml Ajv 校验             │
│                     + 语义校验（引用存在性、类型匹配等）     │
├──────────────────────────────────────────────────────────┤
│  编排               orchestrator.ts                      │
│                     LangGraph DAG 构建 + 执行控制         │
│                     checkpoint.ts    断点持久化 / resume   │
│                     state.ts         路由状态提取          │
│                     report.ts        flow-report.html     │
├──────────────────────────────────────────────────────────┤
│  执行               executor.ts                          │
│                     stage spec → RunConfig → pi CLI 调用  │
│                     runner.ts        进程管理 + NDJSON 流  │
│                     model-config.ts  .env → 模型凭证隔离   │
├──────────────────────────────────────────────────────────┤
│  共享               workspace.ts                         │
│                     输出目录管理 + 引擎 / 产物分离          │
│                     prompt.ts        ${} 变量替换          │
└──────────────────────────────────────────────────────────┘
```

### 提示词四层架构

| 层 | 职责 | 来源 | 注入方式 |
|----|------|------|---------|
| **Agent** | 身份 | `agents/*.md` | `pi --system-prompt` |
| **Skill** | 方法论 | `skills/*/SKILL.md` | `pi --skill` |
| **Task** | 做什么 | `tasks/*.md` | 拼入 user message |
| **Prompt** | 上下文 | flow.yaml `prompt` | `${...}` 变量替换后拼入 user message |

四层都不含运行时变量；运行时上下文只在 flow prompt 中通过 `${work_dir}` / `${output_dir}` / `${iterate_file}` 注入。user message 组装顺序固定为：先拼 `tasks/*.md` 的 Task 内容，再拼变量替换后的 flow.yaml `prompt` 上下文。

### 目录分离

引擎数据与 flow 产物严格分离，类似 Nextflow `.nextflow/`、Snakemake `.snakemake/`：

```
output_dir/
├── .youngflow/              ← 引擎内部数据（agent 不感知）
│   ├── run.yaml             当前 run 元数据
│   ├── checkpoints/         断点恢复文件
│   ├── logs/                per-stage .log（--trace-events 时另有 .events.jsonl）
│   ├── sessions/            pi 会话记录 (.jsonl + .html)
│   ├── flow-report.html     执行状态面板（每 stage 完成后实时刷新）
│   └── runs/                --continue 归档的历史引擎态
│       └── 20260512T123456Z/
│           ├── run.yaml
│           ├── checkpoints/
│           ├── logs/
│           ├── sessions/
│           ├── flow-report.html
│           └── youngflow.log
│
├── profiler/                ← flow 业务产物（干净目录）
├── feature_groups/
├── raw_findings/
└── report/
```

## Flow 资产包

一个 flow 是自包含的目录，可独立于引擎存在、复制、版本控制：

```
flows/vulnhunt/
├── flow.yaml              流水线定义（唯一入口）
├── .env                   模型凭证（可选）
├── agents/                Agent 身份提示词
│   └── security-expert.md
├── skills/                Skill 方法论（每个一目录）
│   ├── project-profiler/
│   │   └── SKILL.md
│   └── ...
├── tasks/                 Task 描述文件
│   ├── profiler.md
│   └── ...
└── schemas/               YAML Schema（可选）
```

## flow.yaml 参考

### 完整结构

```yaml
version: "1.0"
timeout: 7200

# ── 资产目录（相对于 flow.yaml 所在目录）──
artifacts:
  agents: agents/          # Agent 提示词目录
  skills: skills/          # Skill 目录
  tasks: tasks/            # Task 文件目录
  env_file: .env           # 模型凭证文件

# ── 默认配置（可被 stage 级别覆盖）──
defaults:
  model: anthropic/claude-sonnet-4-6:medium    # provider/model:effort
  max_parallel: 3                               # 全局最大并发
  agent: security-expert.md                     # 默认 agent 文件名
  tools:                                        # 默认工具列表
    - read
    - bash
    - write
    - edit
  env:                                          # 自定义环境变量（传给 pi CLI 进程）
    MY_CUSTOM_VAR: some_value

# ── 输入参数（自动生成 CLI 参数）──
inputs:
  work_dir:                    # → --work-dir
    description: "工作目录"
    type: path
  output_dir:                  # → --output-dir
    description: "输出目录"
    type: path

# ── Pipeline 定义 ──
timeout: 7200           # Flow 级总超时秒数（可选）：覆盖整个流水线总运行时长
stages:
  - id: profiler
    name: 工程画像
    skills: [project-profiler]
    task: profiler.md
    prompt: |
      目标项目路径: ${work_dir}
      输出目录: ${output_dir}/profiler/
    timeout: 900
    state:                           # 提取路由状态（供 routes 使用）
      is_valid:
        file: profiler/output.yaml
        field: is_valid_scan_target
      types:
        file: profiler/output.yaml
        keys_of: project_type
        where: is_type == true
    routes:                          # 条件路由
      - to: report
        when: profiler.is_valid == false
      - to: enumerators              # 兜底路由
```

| `timeout` | int | — | Flow 级总超时秒数（可选），覆盖整个流水线从开始执行到结束的总运行时长 |
| `version` | string | — | Flow 定义版本 |
| `artifacts` | object | 默认目录 | 资产目录配置 |
| `defaults` | object | — | 默认配置 |
| `inputs` | object | — | 运行时输入参数 |
| `stages` | list | **必填** | Pipeline 阶段列表 |

### Stage 类型

| type | 调度方式 | 适用场景 | 关键字段 |
|------|---------|---------|---------|
| `single`（默认） | 单节点 | profiler、aggregator | `state` |
| `parallel` | Send fan-out | 固定 N 路并行 | `tasks` |
| `map` | glob + Send | 动态文件数 × 并行 | `over`, `concurrency` |

#### single — 单步

```yaml
- id: profiler
  skills: [project-profiler]
  task: profiler.md
  prompt: |
    目标: ${work_dir}
  state:
    is_valid:
      file: profiler/output.yaml
      field: is_valid_scan_target
  routes:
    - to: enumerators
```

#### parallel — 固定并行

```yaml
- id: enumerators
  type: parallel
  error_strategy: continue
  tasks:
    - id: enum-data
      skills: [data-enumerator]
      task: enumerator.md
      prompt: |
        输出目录: ${output_dir}/perspective_data/
      output_subdir: perspective_data
      when: profiler.has_data_processing == true  # 条件表达式，false 时跳过
    - id: enum-security
      skills: [security-enumerator]
      task: enumerator.md
      prompt: ...
  state:
    feature_count:
      glob: perspective_*/features/FEAT-*.yaml
  routes:
    - to: report                    # 没抓到功能点，直接出报告
      when: enumerators.feature_count == 0
    - to: aggregator
```

#### map — 动态展开

```yaml
- id: security-analyzer
  type: map
  over: "feature_groups/GROUP-*.yaml"   # glob（相对 output_dir）
  filter:                                # 可选：按 YAML/JSON/Markdown frontmatter 字段过滤 map item
    field: "metadata.review_status"      # dotpath
    match: "pending"                     # match / not_match / in / not_in 四选一
    include_missing: true                # 字段缺失时也纳入迭代
  skills: [code-analyzer, bug-report]
  task: analysis.md
  prompt: |
    当前分组: ${iterate_file}            # 当前文件绝对路径
  concurrency: 3                         # 并发上限（默认 max_parallel）
  error_strategy: continue
  routes:
    - to: deep-analyzer
```

### Stage 字段参考

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | string | **必填** | 唯一标识，用于 routes 引用 |
| `name` | string | = id | 显示名称 |
| `type` | string | `single` | `single` / `parallel` / `map` |
| `skills` | list | **必填**(single/map) | Skill 目录名列表 |
| `task` | string | — | Task 文件名（相对 tasks 目录） |
| `prompt` | string | — | 提示词模板，支持 `${...}` 变量 |
| `timeout` | int | 1800 | 节点级超时秒数 |
| `model` | string | defaults.model | 覆盖模型 |
| `agent` | string | defaults.agent | 覆盖 agent 文件名 |
| `error_strategy` | string | `stop` | `stop` / `continue` |
| `extensions` | list | defaults.extensions | 本阶段加载的 extension |
| `env` | object | — | 自定义环境变量（与 defaults.env 合并，stage 优先）|
| `concurrency` | int | max_parallel | map 并发上限 |
| `over` | string | — | map glob 模式（相对 output_dir） |
| `filter` | object | — | map item 过滤；支持 YAML、JSON、Markdown frontmatter 的 `field` + `match` / `not_match` / `in` / `not_in` + `include_missing` |
| `state` | object | — | 状态提取规则（见 [Routes 与 State](#routes-与-state)）|
| `routes` | list | — | 条件路由（见 [Routes 与 State](#routes-与-state)）|
| `tasks` | list | — | parallel 子任务列表 |

### Prompt 变量

| 变量 | 可用范围 | 说明 |
|------|---------|------|
| `${work_dir}` | 所有 stage | pi CLI 工作目录 |
| `${output_dir}` | 所有 stage | 产物输出根目录 |
| `${iterate_file}` | map stage | 当前迭代文件绝对路径 |
| `${flow_inputs.xxx}` | 所有 stage | flow.yaml inputs 中声明的参数 |

### Routes 与 State

Flow 的节点转移完全由 `routes` 驱动。每个 stage 执行完后会评估所有带 `when` 的条件路由，所有命中的目标都会被派发；无 `when` 的 route 是 fallback，只在没有任何条件 route 命中时才走第一条 fallback。没有 routes 或没有可用目标 → flow 终止。

#### Routes

```yaml
routes:
  - to: report
    when: profiler.is_valid == false     # 条件路由
  - to: enumerators                       # 兜底路由（无 when）
```

**规则**：
- 条件格式：`stage_id.key op value`，op 支持 `==`, `!=`, `>`, `>=`, `<`, `<=`
- 所有带 `when` 且条件为 true 的 route 都会被选中；多个目标会并发派发
- 如果至少一个条件 route 命中，无 `when` fallback 不会执行
- 如果没有条件 route 命中，执行第一条 eligible 无 `when` fallback
- 多条命中 route 指向同一 target 时，同一轮只启动一次该 target
- 没有 routes 的 stage = flow 终点
- 回路（指向当前或之前的 stage）必须设置 `max_loops`，防止死循环

#### Join stage

`type: join` 是 engine-only 收口节点，不调用 agent/pi，也不需要 `skills` / `task` / `prompt`。它等待本轮实际派发出去的 branches 全部完成或被 checkpoint skip 后，再评估 join 自己的 routes 一次。

```yaml
- id: discovery
  routes:
    - to: research
      when: discovery.inv_pending > 0
    - to: argument
      when: discovery.hyp_pending > 0
    - to: report          # fallback: 没有 pending work 时才走

- id: research
  type: map
  over: investigations/pending/INV-*.yaml
  routes:
    - to: research_argument_join

- id: argument
  type: map
  over: hypotheses/pending/HYP-*.yaml
  routes:
    - to: research_argument_join

- id: research_argument_join
  type: join
  routes:
    - to: discovery
      max_loops: 10
    - to: report
```

#### State 提取

`state` 从 stage 产物中提取值，供 routes 条件使用。提取结果按 stage 命名空间存储：`extracted[stage_id][key]`。

三种规则类型：

```yaml
state:
  # 1) file + field: 从 YAML 文件读字段（支持 dotted path）
  is_valid:
    file: profiler/output.yaml
    field: is_valid_scan_target

  # 2) file + keys_of + where: 筛选 dict 的键
  types:
    file: profiler/output.yaml
    keys_of: project_type
    where: is_type == true

  # 3) glob: 统计匹配的文件数；可选 filter 会先筛选文件内容再计数
  feature_count:
    glob: perspective_*/features/FEAT-*.yaml
    filter:
      field: metadata.review_status
      match: pending
```

所有路径相对 `output_dir`。

#### 严格语义

- **`file` 规则是硬契约**：文件不存在、字段不存在、YAML 解析失败 → 立即中止 flow，stage 标记为失败（exit_code=1），`extracted[stage_id].state_error` 记录失败原因。这是对前置 stage "必须产出这个文件/字段" 的显式声明，违约即失败。
- **`glob` 规则宽松**：0 匹配是合法答案。带 `filter` 时，只有通过 YAML/JSON/Markdown frontmatter 字段过滤的文件会被计数。如果你想"检查文件是否存在再决定"，用 glob：

```yaml
state:
  has_output:
    glob: profiler/output.yaml
routes:
  - to: error-handler
    when: profiler.has_output == 0
  # 到这里才安全地读文件内容
```

#### 引擎自动注入

每个 stage 执行完后，引擎自动往 `extracted[stage_id]` 里写入：

| key | 含义 |
|-----|------|
| `exit_code` | 0 = 成功，非 0 = 失败 |
| `duration_ms` | 执行耗时（毫秒）|

可直接在 routes 中引用：

```yaml
routes:
  - to: error-handler
    when: analyzer.exit_code != 0
```

#### 完整示例：失败快速终止

```yaml
- id: enumerators
  type: parallel
  tasks: [...]
  state:
    feature_count:
      glob: perspective_*/features/FEAT-*.yaml
  routes:
    - to: report                          # 0 功能点，直接出空报告
      when: enumerators.feature_count == 0
    - to: aggregator                      # 正常流程
```

#### 完整示例：条件回路

```yaml
- id: analyzer
  type: map
  over: "groups/*.yaml"
  state:
    coverage:
      file: analyzer/summary.yaml
      field: coverage_ratio
  routes:
    - to: enumerators                     # 覆盖率不足，回到枚举
      when: analyzer.coverage < 0.8
      max_loops: 2                        # 最多回路 2 次
    - to: deep-analyzer                   # 正常流程
```

## Extensions

Flow 可以通过 [pi extension](https://github.com/badlogic/pi-mono/) 扩展每个 stage 的行为。Extension 运行在 pi CLI 进程内，可以拦截事件、注入上下文、校验产出。

### 配置

```yaml
# flow.yaml
artifacts:
  extensions: extensions/        # extension 目录

stages:
  - id: profiler
    extensions:                   # 本 stage 加载的 extension
      - output-contract
    skills: [project-profiler]
    task: profiler.md
```

引擎自动将 extension 名解析为路径（目录 `extensions/output-contract/` 或文件 `extensions/output-contract.ts`），通过 `pi -e` 传给 pi CLI。

### Stage 环境变量

引擎为每个 pi 进程注入以下环境变量，extension 可通过 `process.env` 读取：

| 变量 | 说明 |
|------|------|
| `YOUNGFLOW_STAGE_ID` | 当前 stage ID |
| `YOUNGFLOW_OUTPUT_DIR` | 产物输出根目录 |
| `YOUNGFLOW_ITERATE_FILE` | 当前迭代文件（仅 map stage） |

### 示例：output-contract extension

校验 stage 产出文件的存在性和内容质量：

```
extensions/output-contract/
├── index.ts          校验逻辑
└── contracts.json    per-stage 规则
```

`contracts.json`：

```json
{
  "profiler": {
    "rules": [
      { "pattern": "profiler/project-profiler.yaml", "chinese_check": true },
      { "pattern": "profiler/basic-scan.md" }
    ]
  },
  "security-analyzer": {
    "rules": [
      { "pattern": "raw_findings/BUG-*.yaml", "min_count": 1, "chinese_check": true }
    ]
  }
}
```

规则字段：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `pattern` | string | **必填** | glob 模式（相对 output_dir） |
| `min_count` | int | 1 | 最少匹配文件数 |
| `chinese_check` | bool | false | 检查文件是否包含中文 |
| `max_retries` | int | 2 | 校验失败后最大重试次数（stage 级） |

行为：
- `agent_end` 时校验所有规则
- 失败 → 日志输出 + 结果写入 `.youngflow/contract-{stage}.json`
- 在交互/RPC 模式下，失败后自动发 follow-up 消息让 agent 修复

## 引擎环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `YOUNGFLOW_IDLE_TIMEOUT` | 300 | pi 进程无输出超时秒数 |
| `YOUNGFLOW_EXPORT_SESSIONS` | 1 | 是否自动导出会话 HTML |

## 模型凭证配置

flow `.env` 文件支持以下变量：

```bash
# 协议类型（openai / anthropic）
MODEL_PROTO_TYPE=openai
# 模型名称
LLM_MODEL_NAME=claude-sonnet-4-6
# 自定义 API 端点（可选，设置后走中转）
LLM_BASE_URL=http://your-proxy:3000/v1
# API Key
LLM_API_KEY=sk-xxx
# 推理力度（可选）
MODEL_EFFORT=medium
```

引擎自动将这些变量转换为 pi 可识别的 `models.json` + `auth.json`，放在 flow 目录下的 `.pi-agent/` 中。

如果 `.env` 未配置或字段缺失，使用 `defaults.model` 指定的模型（需要 pi 本身已配置对应 provider 的凭证）。

## 断点恢复

引擎在每个 stage 完成后写入 checkpoint 到 `.youngflow/checkpoints/`：

```bash
# 首次执行
youngflow flows/vulnhunt/flow.yaml --work-dir ./project -o ./output

# 中断后恢复（自动跳过已完成的 stage）
youngflow flows/vulnhunt/flow.yaml --work-dir ./project -o ./output --resume
```

resume 模式下：
- 已完成的 single / parallel / map stage 整体跳过
- 各 stage 的 `extracted` 状态和 `route_counts`（循环计数）从 checkpoint 恢复
- 产物目录不会被清空（增量执行）

## 基于历史产物继续运行

`--continue` 用于 VulnForge 这类需要复用历史业务产物的新一轮探索。它不同于 `--resume`：

```bash
youngflow flows/vulnhunt/flow.yaml \
  --work-dir ./project \
  --output-dir ./output \
  --continue
```

continue 模式下：
- 保留所有非 `.youngflow` 业务产物，例如 `knowledge/`、`hypotheses/`、`arguments/`、`findings/`、`report/`
- 将旧 active `.youngflow` 引擎态归档到 `.youngflow/runs/<timestamp>/`
- 重新创建 active `.youngflow/checkpoints`、`.youngflow/logs`、`.youngflow/sessions`
- 新 run 从头执行，不复用旧 checkpoint，也不复用 pi session/context
- 当前 `flow-report.html` 的 Run History 会链接历史 run 的 report/log/sessions

`--resume` 与 `--continue` 互斥。已有 active run 时，普通运行会被保护性阻止；请选择 `--resume`、`--continue` 或新的 `--output-dir`。

## LangGraph recursion limit

YoungFlow 会显式传入 LangGraph engine step budget，默认 `100`，避免依赖 LangGraph 默认 `25` 导致 loop-heavy flow 提前触发 `GraphRecursionError`。

配置优先级：CLI `--recursion-limit` > flow.yaml 顶层 `recursion_limit` > 默认 `100`。

```yaml
recursion_limit: 200
```

```bash
youngflow flows/vulnhunt/flow.yaml --work-dir ./project --output-dir ./output --recursion-limit 200
```

注意：`recursion_limit` 是 LangGraph engine node-step 上限；`routes[].max_loops` 仍是 YoungFlow flow 层业务循环安全阀，二者语义不同。

## 运行日志

每个 stage 默认产生一个人类可读日志；如显式开启 `--trace-events`，会额外保存 compact 后的 pi 事件流：

| 文件 | 内容 |
|------|------|
| `.youngflow/logs/{stage_id}.log` | 人类可读日志：工具调用、错误、统计 |
| `.youngflow/logs/{stage_id}.events.jsonl` | 可选；`--trace-events` 开启时保存 compact 后的 pi CLI NDJSON 事件流，用于底层调试 |

默认不保存 `.events.jsonl`，因为流式 update / subagent 快照可能非常大；常规排障优先查看 `.log`、`youngflow.log`、`session.html` 和 `flow-report.html`。

日志中的关键指标：
```
DONE: exit=0 duration=374978ms turns=22 tools=52
      tokens_in=86651 tokens_out=13248 empty=0
```

## 发布二进制

本项目支持用 `@yao-pkg/pkg` 打包 standalone 二进制：

```bash
npm run build:binary
```

默认输出到 `release/`：

- `youngflow-linux-x64`
- `youngflow-macos-x64`
- `youngflow-macos-arm64`
- `youngflow-win-x64.exe`

也可以只构建指定 target：

```bash
PKG_TARGETS=node20-linux-x64 npm run build:binary
PKG_TARGETS=node20-macos-x64,node20-macos-arm64 npm run build:binary
```

推送 `v*` tag 会触发 GitHub Actions 构建并发布 release assets：

```bash
git tag v0.1.0
git push origin v0.1.0
```

注意：YoungFlow 二进制只包含 YoungFlow 自身；运行 flow 时仍需要系统中可执行的 `pi` CLI。

## 前置依赖

- [pi](https://github.com/badlogic/pi-mono/) CLI（已安装且可执行）
- Node.js ≥ 20

```bash
# 验证
pi --version
node --version
```

## 代码结构

```
youngflow-js/
├── bin/youngflow.js                    CLI 入口
├── package.json                        youngflow 0.1.0
└── src/                                14 模块
    ├── cli.ts                          CLI：动态参数生成
    ├── spec.ts                         Spec：YAML → readonly types + 校验
    ├── flow.schema.yaml                JSON Schema 定义
    ├── prompt.ts                       提示词：${} 变量替换
    ├── orchestrator.ts                 编排：LangGraph DAG（single/parallel/map）
    ├── checkpoint.ts                   持久化：.youngflow/checkpoints/
    ├── state.ts                        路由状态提取
    ├── condition.ts                    条件表达式求值
    ├── report.ts                       flow-report.html 生成
    ├── executor.ts                     执行：stage spec → RunConfig → pi CLI
    ├── runner.ts                       pi 进程 + NDJSON 事件流 + 重试
    ├── model-config.ts                 .env → models.json / auth.json
    ├── engine-config.ts                引擎运行时配置
    ├── workspace.ts                    目录管理
    └── index.ts                        公共导出
```
