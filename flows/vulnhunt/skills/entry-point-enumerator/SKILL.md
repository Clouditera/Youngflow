---
id: vulai/entry-point-enumerator
name: Entry Point Enumerator
description: 入口点枚举技能 - 从项目代码中系统性地枚举所有外部输入入口点（HTTP 端点、API 路由、文件读取接口、消息队列消费者等），生成结构化的功能点特征卡。是安全分析的第一步，决定了后续分析的覆盖广度。
category: enumeration
tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
triggers:
  keywords:
    - 入口点枚举
    - 端点发现
    - 功能点识别
    - entry point enumeration
    - endpoint discovery
    - route enumeration
    - external interface
    - entry-point-enumerator
  intentPatterns:
    - "(enumerate|discover|find|list|scan).*?(entry.?point|endpoint|route|interface)"
    - "(发现|枚举|识别|列出).*?(入口|端点|路由|接口)"
    - "what.*?(entry|endpoint|route|interface).*?(exist|available|defined)"
constraints:
  rateLimit: unlimited
  timeout: 600
---

# Entry Point Enumerator Skill

## 概述与边界

本技能负责从目标代码中枚举所有外部输入入口点，包括但不限于：
- HTTP 端点（路由、Servlet 映射）
- WebSocket / SSE 端点
- 文件上传接口
- 消息队列消费者
- 定时任务 / 批处理入口
- 回调接口 / Webhook

**关键原则**：枚举时必须覆盖每种入口点的**所有**处理分支。仅枚举 GET 处理器而忽略 PUT/POST/DELETE 处理器会遗漏安全相关的写入通道。

## 枚举范围

### HTTP Servlet 入口点

对于任何继承自 `HttpServlet` 或 `GenericServlet` 的类，枚举规则如下：

**规则 1（多方法覆盖）**：当一个 Servlet 类包含多个 HTTP 方法处理器（`doGet`、`doPut`、`doPost`、`doDelete`、`doHead`、`doOptions`、`doTrace`）时，**必须为每个处理器方法分别枚举为独立入口点**。不能只枚举 `doGet` 而忽略其他方法。

**规则 2（service 分派）**：如果 Servlet 覆写了 `service()` 方法进行自定义分派，需要分析 `service()` 方法中的 `getMethod()` 分派逻辑，为每个被分派的 HTTP 方法创建独立入口点。

**规则 3（写入方法标记）**：对于 `doPut`、`doDelete`、`doPost` 等写入类 HTTP 方法，在入口点元数据中标记 `risk_direction: write`，因为这些方法通常涉及文件操作、数据修改或状态变更。

### REST / MVC 框架入口点

**规则 4（注解路由）**：对于使用注解定义路由的框架（如 Spring MVC、JAX-RS、FastAPI、Flask），需要解析所有 HTTP 方法注解：
- `@GetMapping` / `@Get` / `@HttpGet` / `@RequestMapping(method=GET)`
- `@PostMapping` / `@Post` / `@HttpPost` / `@RequestMapping(method=POST)`
- `@PutMapping` / `@Put` / `@HttpPut` / `@RequestMapping(method=PUT)`
- `@DeleteMapping` / `@Delete` / `@HttpDelete` / `@RequestMapping(method=DELETE)`
- `@PatchMapping` / `@Patch` / `@HttpPatch`

每个注解方法应生成独立的入口点记录。

**规则 5（方法级路由分离）**：当同一个 URL 路径绑定到多个不同 HTTP 方法时（如 `GET /users` 和 `POST /users`），即使路由定义文件相同，也必须作为**两个独立入口点**枚举。

### 文件上传入口点

**规则 6（多部件表单）**：识别所有处理 `multipart/form-data` 的端点，包括：
- Servlet 中使用 `HttpServletRequest.getPart()` 或 `request.getParts()`
- 框架中的文件上传方法参数（如 `@RequestParam("file") MultipartFile`）
- 任何涉及 `tempFile`、`tmpFile`、`File.createTempFile` 的方法

### 消息队列与回调

**规则 7（消费者注解）**：识别消息队列消费者注解：
- `@JmsListener`、`@RabbitListener`、`@KafkaListener`（Java）
- `@celery.task`（Python）
- `async def consume`（异步消费者）

## 入口点元数据格式

每个枚举的入口点应包含以下元数据：

```yaml
entry_point:
  id: ep-{seq}
  type: http | websocket | file_upload | mq_consumer | callback
  url_pattern: /path/with/{param}
  http_methods: [GET, PUT, POST, DELETE]
  handler:
    class: FullyQualifiedClassName
    method: handlerMethodName
    file: path/to/file.java
    line: N
  risk_direction: read | write | both
  auth_required: true | false
  input_format: json | xml | multipart | form | binary
```

**注意**：`http_methods` 字段必须列出该端点支持的所有 HTTP 方法。如果一个 Servlet 支持 GET/PUT/DELETE，必须全部列出。当 `http_methods` 包含 `write` 类方法（PUT/POST/DELETE/PATCH）时，`risk_direction` 必须为 `write` 或 `both`。

## 常见遗漏模式

以下模式是枚举器常见的遗漏点，需要特别注意：

| 遗漏模式 | 风险 | 枚举要求 |
|---------|------|---------|
| 只枚举 `doGet`，忽略 `doPut`/`doDelete` | 高 | 所有 HTTP 方法处理器必须分别枚举 |
| Servlet 支持 PUT 但只记录 GET 路由 | 高 | 同一 URL 的所有 HTTP 方法都要枚举 |
| `service()` 方法分派逻辑未展开 | 高 | 分析 `service()` 并为每个分支创建入口点 |
| 文件上传的 `doPost` 被当作普通端点 | 中 | 标记 `input_format: multipart` |
| `readonly=false` 配置未关联到具体写入方法 | 中 | 将配置参数关联到 `doPut`/`doDelete` 方法 |

## 输出

生成 `entry-points.yaml`，格式如下：

```yaml
entry_points:
  - id: ep-001
    type: http
    url_pattern: /*
    http_methods: [GET, PUT, DELETE, POST, HEAD, OPTIONS]
    handler:
      class: org.apache.catalina.servlets.DefaultServlet
      method: doGet
      file: java/org/apache/catalina/servlets/DefaultServlet.java
      line: 500
    risk_direction: both
    servlet_methods_covered:
      - doGet
      - doPut
      - doDelete
      - doPost
      - doHead
```

## 枚举流程

1. **扫描 Servlet 定义**（web.xml、注解配置）
   - 识别所有 Servlet 映射（`url-pattern`）
   - 获取对应的 Servlet 类名

2. **解析 Servlet 类**
   - 读取 Servlet 类的 Java 源文件
   - 识别所有覆写的 HTTP 方法（doGet/doPut/doPost/doDelete 等）
   - 如果覆写了 `service()`，分析分派逻辑

3. **为每个 HTTP 方法处理器创建入口点**
   - 每个 `doXxx` 方法对应一个入口点
   - 记录方法签名行号

4. **关联配置参数**
   - 将 Servlet 初始化参数（如 `readonly`、`allowPartialPut`）关联到对应的方法处理器
   - 特别关注 `readonly=false` 与 `doPut`/`doDelete` 的关联

5. **生成结构化输出**
   - 输出到 `entry-points.yaml`
