# 枚举覆盖率审核任务

## 任务目标

对所有已生成的功能点卡片做全局交叉验证，发现遗漏和不一致。不需要读源码，只做结构化比对。

## 输入

1. 工作上下文中指定的项目画像文件 — 项目画像（包含所有已知入口）
2. 所有 `FEAT-ri-*.yaml` 卡片
3. `read-coverage.yaml` — 本节点的文件读取覆盖率清单（由 hook 自动生成，列出 agent 实际 Read 过的所有项目文件）

## 检查项

### 1. 入口覆盖率

- 从 profiler 的 `route_snippets` 提取所有路由
- 从所有卡片的 `entry_points` 提取已覆盖的入口
- 找出未被任何卡片覆盖的路由 → 报告为 **遗漏入口**

### 2. code_locations 合理性

- 每张卡片的 `entry_points` 数量 vs `code_locations` 数量
  - N 个入口只有 1 个 code_locations 文件 → **可能追踪不完整**
- `start_line == end_line`（单行覆盖）→ **大概率是错误**
- `code_locations` 中是否只有路由注册文件而缺少 handler 实现文件 → **追踪断裂**

### 3. 跨卡片关联

- 找出多张卡片 `code_locations` 中出现的同一文件
- 检查这些卡片的 `related_features` 是否互相引用
- 未引用则建议补充

### 4. 认证一致性

- `auth_required: false` 的卡片必须在 `security_mechanisms.note` 中说明哪些入口缺认证
- 检查同一功能域内的认证状态是否自洽

### 5. 文件读取覆盖率（使用 read-coverage.yaml）

如果 `read-coverage.yaml` 存在，执行以下检查：

- 对比 `read-coverage.yaml` 中的 `project_files_read` 与 工作上下文中指定的项目画像文件 中的关键文件（route_files、dynamic_dispatch.implementation_dirs 下的文件）
- 找出**应该被读但未被读的文件**：在 profiler 中标记为入口文件或动态分发实现目录下的文件，但不在 read-coverage 中
- 这些未读文件报告为 **⚠️ 需修复**，主 agent 应派发补充 subagent 对这些文件做深层追踪

## 输出格式

问题清单，每条包含：

```
严重程度：⚠️ 需修复 / 💡 建议改进
涉及卡片：FEAT-ri-NNN
问题描述：{具体问题}
建议动作：{如何修复}
```
