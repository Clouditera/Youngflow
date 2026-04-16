# 功能域追踪方法论

## 任务目标

对一个功能域的所有入口做深层代码追踪，生成一张标准化功能点卡片（FEAT-ri-*.yaml）。追踪的完整度是第一优先级。

## 方法论

### 追踪深度要求

从每个入口开始，追踪完整的数据流路径：

```
入口注册 → handler 实现 → 业务逻辑 → 数据操作/外部调用/输出
```

- **必须追踪到 handler 实现**：路由文件通常只包含绑定关系，业务逻辑在 handler 定义文件中
- **跨文件调用至少追踪 2 层**：重点关注数据操作、外部调用、输入验证、动态分发、内容渲染、响应构造
- **动态分发入口**：找到实现目录中对应模块，读取模块的所有导出函数（不仅是搜索关键词匹配的函数）

### code_locations 要求

- 覆盖数据流路径上的**所有文件**，不仅是入口文件
- 行范围必须是**完整函数体**（函数签名到闭括号），不是 grep 命中行 ± N 行
- 用 Read 工具实际读取文件确认函数边界
- **大文件处理**：先用搜索定位目标函数行号，再分段 Read 确认。禁止只读前 100 行就下结论

### 认证检查

两层检查：
1. **注册层**：入口注册时是否绑定了认证中间件/守卫/装饰器
2. **实现层**：handler 函数内部前 15-20 行是否有认证/授权逻辑

只要功能域内有任何一个入口无认证，`auth_required` 必须为 `false`。

### 风险评估

| 等级 | 判定 |
|------|------|
| high | 无认证 + 写操作/敏感数据/代码执行/文件操作；路径含通配符参数的写操作；内部代码执行引擎 |
| high | HTTP handler 从对象存储/文件系统读取文件并返回给浏览器客户端，且 Content-Type 由客户端可控输入（文件名、扩展名、Content-Type header）决定，而非服务端强制验证，且返回内容在浏览器中可能被渲染执行（如 HTML、SVG、PDF 嵌入脚本），且同一服务域下存在其他可信管理界面（如 WebUI Console） |
| medium | 认证不一致（部分有部分无）；公开的批量/资源消耗型操作 |
| medium | HTTP handler 返回文件内容，但 Content-Type 来自服务端信任的数据源（如数据库元数据、系统配置）而非客户端直接可控的输入，但服务端未对内容本身做安全检查（X-Content-Type-Options: nosniff 未设置，或允许浏览器类型嗅探） |
| low | 设计为公开的只读（静态资源、健康检查）；认证完整的标准 CRUD |

**补充说明（风险类型优先级）**：当 handler 从对象存储/文件系统读取文件返回给浏览器时，即使文件路径涉及路径穿越或读取操作，风险类型应优先识别为 `xss` / `stored_xss`，而非 `path_traversal` 或 `information_disclosure`。理由：攻击者上传恶意 HTML/JS 文件后通过文件预览接口触发，核心危害是前端代码执行，而非文件内容泄露。

### 用户 Profile 渲染与其他 Markdown 渲染的区分追踪

**重要原则**：用户提交内容在 profile 页面的 Markdown 渲染，必须作为**独立功能域**追踪，生成独立卡片，不能与 API markup 端点合并。

**区分原因**：
- API markup 端点（如 `POST /api/v1/markup`）通常是开发者工具或预览功能，输入来源是请求体
- 用户 profile 渲染的输入来源是数据库中存储的用户自定义字段（description、bio 等），攻击路径是"用户 A 提交恶意内容 -> 存入数据库 -> 其他用户访问 A 的 profile 时触发 XSS"
- 两者的攻击面、触发条件和防护要求完全不同，必须独立追踪

**追踪要点**：
1. 从 user profile handler 出发（如 `routers/web/user/profile.go`、`routers/web/user/home.go`），追踪用户模型字段（description、bio 等）经 `markdown.RenderString` 渲染后存入 `ctx.Data` 的完整链路
2. 必须包含模板输出文件（如 `templates/shared/user/profile_big_avatar.tmpl`），确认渲染结果以 `{{.RenderedDescription}}` 形式原样输出
3. 必须包含 HTML sanitizer 实现文件（如 `modules/markup/sanitizer.go`），确认 sanitizer 对 SVG 等危险元素是否有覆盖缺口
4. 将 `modules/markup/markdown/markdown.go` 的 `RenderString` 函数（返回 `template.HTML`）纳入 code_locations — 这是高风险 XSS sink 的核心实现

**独立卡片命名建议**：`User Profile Markdown Rendering`（与 `Markdown and Content Rendering` 卡片区分）

### 完成自检

生成卡片前验证：
- 每个 entry_point 的 handler 都在 code_locations 中
- processing_chain 引用的文件都在 code_locations 中
- code_locations 行范围是完整函数体（用 Read 确认过）
- 大文件（>200 行）确认读取了目标函数所在行
- **用户 profile 渲染卡片**：确认 sanitizer 文件和模板输出文件都在 code_locations 中

## 输出格式

写入 `{output_dir}/features/FEAT-ri-{NNN}-{short_name}.yaml`：

```yaml
feature:
  id: "feat-ri-{NNN}"
  name: "{功能域名称}"
  perspective: "route-interface"
  risk_level: "{high/medium/low}"
  risk_rationale: "{具体原因}"
  description: "{功能描述}"
  language: "{语言}"

  entry_points:
    - type: "{协议类型}"
      path: "{路径}"
      file: "{文件}"
      line: {行号}

  data_flow:
    input_format: "{输入格式描述}"
    processing_chain:
      - step: 1
        action: "{处理动作}"
        file: "{文件}"
        line: {行号}
        function: "{函数名}"
    output_format: "{输出格式}"
    secondary_parsing: false

  security:
    auth_required: {true/false}
    security_mechanisms:
      - name: "{机制名称}"
        coverage: "{full/partial/none}"
        location: "{文件:行号}"
        note: "{说明}"
    potential_risks:
      - risk_type: "{风险类型}"
        description: "{描述}"

  code_locations:
    - file: "{文件}"
      start_line: {起始行}
      end_line: {结束行}
      code_type: "{route_handler/business_logic/utility/dispatch_layer}"

  related_features: []
  discovered_by: "entry-point-enumerator"
  confidence: "high"
```
