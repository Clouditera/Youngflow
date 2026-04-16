# 覆盖率审核任务

## 任务目标

对所有已生成的外部交互功能点卡片做全局交叉验证，发现遗漏和不一致。不需要读源码，只做结构化比对。

## 输入

1. 工作上下文中指定的项目画像文件 — 项目画像（包含 external_interactions 摘要）
2. 所有 `FEAT-ei-*.yaml` 卡片
3. `read-coverage.json` — 本节点的文件读取覆盖率清单（由 hook 自动生成，列出 agent 实际 Read 过的所有项目文件）

## 检查项

### 1. 交互类型覆盖

- 根据 profiler 中的 `external_interactions`、`tech_stack`、`language` 推断项目应存在的交互类型（网络请求/数据库/文件系统/命令执行/消息传递/动态加载）
- 从所有卡片的 `potential_risks.risk_type` 和 `code_locations.code_type` 提取已覆盖的交互类型
- 找出未被任何卡片覆盖的交互类型 -> 报告为 **遗漏类型**（需评估是否合理——某些项目确实不存在某类交互）

### 2. 溯源完整性

- 每张卡片是否都有 `processing_chain` 且追踪到了用户输入来源
- `entry_points` 是否标注了触发入口类型（HTTP handler / CLI / 定时任务等）
- 涉及 HTTP 客户端的卡片是否标注了响应数据去向

### 3. code_locations 合理性

- 每张卡片的 `entry_points` 数量 vs `code_locations` 数量
  - N 个交互点只有 1 个 code_locations 文件 -> **可能追踪不完整**
- `start_line == end_line`（单行覆盖）-> **大概率是错误**
- `code_locations` 中是否只有交互调用文件而缺少调用者/封装层文件 -> **追踪断裂**

### 4. 独立脚本覆盖

- `scripts/`、`bin/`、`cron/`、`jobs/`、`tasks/` 等目录下的命令执行/数据库操作是否被覆盖
- 如果 profiler 显示项目存在这些目录但无对应卡片 -> 报告为 **遗漏**

### 5. 文件读取覆盖率（使用 read-coverage.json）

如果 `read-coverage.json` 存在，执行以下检查：

- 对比 `read-coverage.json` 中实际读取的项目文件与 profiler 中的关键文件
- 找出**应该被读但未被读的文件**：在 profiler 中标记为包含外部交互的文件，但不在 read-coverage 中
- 这些未读文件报告为 **需修复**，主 agent 应派发补充 subagent 对这些文件做深层追踪

## 输出格式

问题清单，每条包含：

```
严重程度：需修复 / 建议改进
涉及卡片：FEAT-ei-NNN（或"全局"）
问题描述：{具体问题}
建议动作：{如何修复}
```
