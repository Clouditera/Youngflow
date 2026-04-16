# 覆盖率审核规则

## 任务目标

对所有已生成的功能点卡片做全局交叉验证，发现遗漏和不一致。不需要读源码，只做结构化比对。

## 输入

1. 阶段 A 的格式清单
2. 所有 `FEAT-dp-*.yaml` 卡片
3. `read-coverage.json` — 本节点的文件读取覆盖率（由 hook 自动生成）

## 检查项

### 1. 格式覆盖率

- 对照阶段 A 格式清单，是否每种格式都有对应卡片？
- 未覆盖格式 → **需修复**

### 2. 二次解析交叉关联

- 检查格式间的二次解析关系是否被正确记录
- 如 XML 卡片和 ZIP 卡片是否相互引用

### 3. code_locations 完整性

- 安全关键文件是否覆盖完整行范围？
- 调度层文件是否遗漏？
- `start_line == end_line`（单行覆盖）→ **大概率是错误**

### 4. risk_level 一致性

- 检查强制提升规则是否被正确应用
- 存在二次解析但 risk_level 不是 high → **需修复**

### 5. 文件读取覆盖率（使用 read-coverage.json）

如果 `read-coverage.json` 存在：

- 对比已读文件与格式清单中标记的关键文件
- 找出**应该被读但未被读的文件** → **需修复**

### 6. 用户 Profile Markdown 渲染覆盖专项检查

**高风险遗漏模式**：项目存在用户提交内容（description、bio 等）经 Markdown 渲染后在页面输出的代码路径，但 markdown 渲染卡片的 code_locations 没有覆盖这些路径。

**检查方法**：
1. 搜索用户 profile handler 文件中调用 `markdown.RenderString` 且入参来自用户模型字段的代码
2. 如果存在这类代码，检查现有 markdown 渲染卡片的 `code_locations` 是否包含：
   - 用户 profile handler 文件（如 `routers/web/user/profile.go`、`routers/web/shared/user/header.go`）
   - HTML sanitizer 文件（如 `modules/markup/sanitizer.go`）
   - 模板输出文件（如 `templates/shared/user/profile_big_avatar.tmpl`）
3. 如果缺少上述文件中的任何一个，报告为 **需修复** — 必须补充追踪，将用户 profile 渲染链路纳入 markdown 渲染卡片的 code_locations

## 输出格式

问题清单，每条包含：

```
严重程度：需修复 / 建议改进
涉及卡片：FEAT-dp-NNN
问题描述：{具体问题}
建议动作：{如何修复}
```
