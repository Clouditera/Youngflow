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

### Forced Browsing / Direct Request（CWE-425）检测规则

Forced Browsing 是一种认证绕过漏洞：攻击者直接访问本应需要认证才能到达的 URL、视图或功能端点，而不需要合法用户的会话。这是 Web 应用中最常见的认证绕过模式之一。

#### 典型代码模式

**模式 A：路由 handler 中视图渲染路径缺少认证检查**

```
路由 handler（接收 URL 参数）→ 解析配置（如 XML/controller/路由表）→ 直接 render/forward 视图
```

在某些 Web 框架中，handler 接收路由参数后，从配置文件（如 controller.xml、routes.conf）中解析目标视图或资源，然后直接渲染返回。整个路径中没有任何 session 检查或认证验证。

**识别特征**：
1. handler 函数中读取了 `userLogin` 或 `session` 对象，但仅用于记录或日志，**没有用于流程控制**（即 `if (userLogin == null) return;`）
2. handler 从配置（XML/JSON/数据库）中解析视图名称或目标 URL，然后直接将控制权交给视图渲染函数
3. 配置文件中存在 `auth=false` 或缺失安全属性，且框架默认值为不安全状态

**示例代码模式（用于识别，不要在规则中硬编码具体类名）**：
```java
// 路由 handler，接收 viewName 参数
private void renderView(String view, HttpServletRequest req, HttpServletResponse resp) {
    GenericValue userLogin = (GenericValue) req.getSession().getAttribute("userLogin");
    // userLogin 被读取但从未被用于认证检查
    // 直接从配置解析视图处理器
    ViewHandler handler = ViewFactory.getViewHandler(view);
    // 直接渲染，没有任何 session 检查
    handler.render(view, req, resp);
}
```

**模式 B：配置驱动的路由分发，认证检查被配置层绕过**

```
URL 请求 → ControlFilter/TokenFilter（检查是否在白名单）→ RequestHandler（解析 request-map）→ 直接渲染视图
```

某些框架的认证机制（Filter/Interceptor）只保护显式配置了认证的端点，而 request-map / view-map 配置驱动的分发点可能不在 Filter 的保护范围内。当 handler 从 request-map 中解析出目标视图后直接渲染时，认证检查被绕过。

**识别特征**：
1. Filter/Interceptor 存在认证机制，但覆盖范围限于显式路由映射
2. request-map 或 view-map 配置中的视图渲染端点不受 Filter 保护
3. 同一文件中既有认证检查逻辑（某些路径有 `if (userLogin != null)`）又有无认证的渲染路径

#### 追踪步骤

1. **定位渲染入口**：搜索 `render`、`forward`、`view`、`dispatch` 等关键词，找到视图渲染或请求分发的核心函数
2. **追踪认证上下文**：在该函数内搜索 `userLogin`、`session`、`getAttribute("userLogin")`、`isAuthenticated` 等session检查代码
3. **判断认证有效性**：如果 session 对象被读取但从未用于条件分支（`if/else`），或 session 检查在视图渲染/分发之后执行，则存在 Forced Browsing 风险
4. **追溯配置层**：如果视图名称来自配置文件（XML/JSON），检查配置文件中对应条目的认证属性（`auth`、`security`、`requiresAuth` 等）
5. **确认安全默认值**：检查框架配置 schema 中安全属性的默认值，如果默认值为 `false` 或缺失，则为危险默认值

#### 风险评估要点

| 条件 | 判定 |
|------|------|
| view-map/request-map 配置了 `auth=false` 或缺失安全属性，且默认值为 false | Forced Browsing，high |
| handler 读取了 session 对象但从未做条件检查，直接渲染视图 | Forced Browsing，high |
| Filter 认证机制存在但不覆盖配置驱动的分发路径 | Forced Browsing，medium-high |
| session 检查在 render/forward 之后执行（检查无用） | Forced Browsing，high |
| 同一文件中有认证和不认证的路径，但业务逻辑上应统一认证 | Forced Browsing，medium |

#### 区分 Forced Browsing 与其他风险类型

- **Forced Browsing vs Path Traversal**：Forced Browsing 的核心是"无需认证即可访问受限视图"，Path Traversal 的核心是"通过路径穿越访问非预期文件"。如果代码在视图渲染前完全没有认证检查，应优先归类为 Forced Browsing。如果代码已有认证层，只是路径处理有问题，才考虑 Path Traversal。
- **Forced Browsing vs Auth Bypass**：Auth Bypass 通常指通过会话劫持、令牌伪造、权限提升等方式绕过认证。Forced Browsing 特指通过直接访问本应受保护的 URL 而不需要任何认证凭证。
- **优先级**：当一个 URL 同时存在 Forced Browsing 和其他漏洞特征时，Forced Browsing 应作为主要风险类型记录，因为它代表了更深层的认证架构缺陷。

### 完成自检

生成卡片前验证：
- 每个 entry_point 的 handler 都在 code_locations 中
- processing_chain 引用的文件都在 code_locations 中
- code_locations 行范围是完整函数体（用 Read 确认过）
- 大文件（>200 行）确认读取了目标函数所在行

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
