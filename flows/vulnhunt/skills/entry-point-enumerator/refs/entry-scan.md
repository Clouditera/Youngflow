# 入口扫描方法论

## 任务目标

在指定范围内发现所有用户可达入口点，输出完整的入口清单。完整性是第一优先级——宁可多报，不可漏报。

## 方法论

### 搜索完整性

- **多角度交叉验证**：对同一类入口，用至少 3 种不同的搜索模式验证，避免单一模式的盲区
- **不截断搜索结果**：禁止对搜索结果做 head/tail 截断。如果结果过多，按子目录分批搜索缩小范围
- **目录广度覆盖**：扫描所有源码目录，不局限于 `src/`。monorepo 中每个包都要检查
- **隐式入口不遗漏**：约定路由（目录结构即路由）、事件监听器、消息消费者、定时任务、框架自动注册端点

### 验证要求

- 搜索命中必须验证：确认是实际入口注册，不是注释、测试或字符串常量
- 对大文件或搜索结果密集的文件，Read 确认上下文

### 用户主页 Markdown 渲染入口（专项补盲）

除了 `/api/v1/markup` 等 API 端点外，**用户个人主页页面**本身也是 Markdown 渲染的独立入口。此类入口的特征是：handler 从用户模型字段（description、bio、readme 等）读取内容，调用 Markdown 渲染函数（如 `markdown.RenderString`），将结果存入 `ctx.Data` 传递到模板，最终由模板原样输出到页面。

**这是 Stored XSS 的经典攻击面**：用户提交的内容经 Markdown 渲染后以 `template.HTML` 类型输出（Go 模板不对 `template.HTML` 做自动转义），如果 HTML 净化器（sanitizer）存在覆盖缺口（如允许 SVG 元素），则可导致存储型 XSS。

**必须补盲的检测维度**（段 2 强制执行，不受 0-files 约束）：

1. **用户描述渲染入口**：在 handler 中搜索 `markdown.RenderString` + 用户模型字段（如 `User.Description`、`user.bio` 等用户自定义字段）组合模式。该模式表明用户提交的内容被渲染后输出到页面。
   - 搜索方向：在 `routers/web/` 目录下，查找调用 `markdown.RenderString` 且入参来自用户模型字段的 handler
   - 典型代码模式：`markdown.RenderString(&markup.RenderContext{...}, ctx.ContextUser.Description)` 后紧跟 `ctx.Data["RenderedDescription"]`

2. **用户 README 渲染入口**：在 handler 中搜索 `markdown.RenderString` + 用户级别 README/overview 相关字段组合模式。
   - 搜索方向：在 `routers/web/user/` 目录下，查找渲染用户个人页面中 README 内容的 handler
   - 典型代码模式：`markdown.RenderString` 后将结果存入 `ctx.Data["ProfileReadme"]` 或类似字段

3. **Feed/通知中的用户内容渲染**：在 feed 或通知生成代码中，查找对用户提交内容进行 Markdown 渲染的路径。
   - 搜索方向：在 `routers/web/feed/` 或 `services/mailer/` 目录下，查找渲染用户 description 的 handler
   - 典型代码模式：`markdown.RenderString` 后将结果存入 `ctxUserDescription` 或类似字段

4. **`template.HTML` 返回模式**（关键检测信号）：搜索 `template.HTML` 与 `RenderString` 的组合，这是用户提交内容在模板层原样输出的关键特征。
   - 搜索方向：在 `modules/markup/` 目录下，查找 `RenderString` 函数返回 `template.HTML` 类型的实现
   - 典型代码模式：`return template.HTML(buf.String()), nil` — 这种强制类型转换告诉调用方内容是安全的，模板引擎不会转义
   - **注意**：这种模式通常出现在 `markdown.RenderString` 等渲染函数中，是高风险 XSS 攻击面的核心指标。发现此模式后，必须向上回溯，找到所有调用该渲染函数的 handler，确认是否有来自用户模型字段的输入路径

**验证标准**：搜索命中后必须验证：
- 渲染函数的入参是用户可控字段（来自数据库模型的用户输入）
- 渲染结果通过 `ctx.Data` 传递给模板（模板以 `{{.RenderedXxx}}` 或 `{{$.RenderedXxx}}` 形式输出）
- 输出点位于用户个人主页或 feed 页面（非仅 API 响应）

**输出标记**：上述入口统一标记为 `user_profile_markdown_rendering`，与其他 markdown 渲染入口（如 API markup）区分。

### 动态分发入口

如果项目存在动态分发架构（入口通过运行时配置路由到不同实现）：

1. 分发入口本身记录为入口点，标记"动态分发"
2. 实现目录下的每个模块也记录为潜在入口点
3. 实现模块中的入口标记"由 {dispatch_entry} 动态调用"

## 输出格式

每个入口一行，用 `|` 分隔：

```
协议类型 | 路径/标识 | 文件 | 行号 | 备注
```

示例：
```
http | GET /api/users | UserController.java | 45 | @RequestMapping
http | POST /webhook/:path | WebhookController.ts | 12 | 动态分发
ws | /ws/notifications | NotificationHandler.java | 30 | WebSocket endpoint
cli | backup create | backup.go | 55 | cobra subcommand
```
