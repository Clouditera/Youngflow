# Entry Point Scan Reference

## 通用检测模式

### Java Servlet Detection

#### Pattern 1: Multi-Method Servlet（多方法 Servlet）

**触发条件**：读取一个继承 `HttpServlet` 的类，发现其包含**多个** HTTP 方法处理器。

**检测步骤**：

```
1. 扫描项目中的 .java 文件，匹配类声明：
   - extends HttpServlet
   - extends GenericServlet
   - extends jakarta.servlet.http.HttpServlet
   - extends javax.servlet.http.HttpServlet

2. 对每个匹配的类，扫描以下方法声明：
   - protected void doGet(HttpServletRequest, HttpServletResponse)
   - protected void doPut(HttpServletRequest, HttpServletResponse)
   - protected void doPost(HttpServletRequest, HttpServletResponse)
   - protected void doDelete(HttpServletRequest, HttpServletResponse)
   - protected void doHead(HttpServletRequest, HttpServletResponse)
   - protected void doOptions(HttpServletRequest, HttpServletResponse)
   - protected void doTrace(HttpServletRequest, HttpServletResponse)

3. 如果找到 2 个或以上的方法处理器，必须为每个方法创建独立入口点。
```

**正则表达式**：
```
method_signature: (protected|public|private)\s+void\s+do(Get|Put|Post|Delete|Head|Options|Trace)\s*\(
```

**入口点模板**（每个方法处理器一个）：

```yaml
entry_point:
  id: ep-{seq}
  type: http
  url_pattern: {from servlet mapping}
  http_methods: [{METHOD}]
  handler:
    class: {fully.qualified.ClassName}
    method: {doMethod}
    file: {path/to/ClassName.java}
    line: {line number of method signature}
  risk_direction: write   # for PUT/POST/DELETE/PATCH
  risk_direction: read    # for GET/HEAD/OPTIONS/TRACE
  servlet_init_params:
    readonly: {value from web.xml or @WebInitParam}
    allowPartialPut: {value}
```

#### Pattern 2: Service Method Dispatcher（service() 方法分派器）

**触发条件**：Servlet 覆写了 `service()` 方法而不是依赖默认分派。

**检测步骤**：

```
1. 在 Servlet 类中查找 service() 方法覆写：
   - protected void service(HttpServletRequest, HttpServletResponse)
   - @Override public void service(ServletRequest, ServletResponse)

2. 分析 service() 方法体中的分派逻辑：
   - 查找 getMethod() 调用
   - 查找 if/else 或 switch 对 HTTP 方法名的判断
   - 查找对 request.getMethod() 的比较

3. 为每个被分派的 HTTP 方法创建独立入口点。
```

**正则表达式**：
```
# service() method override
method_signature: (protected|public)\s+void\s+service\s*\(
# HTTP method dispatch check
dispatch_check: (getMethod\(\)|request\.getMethod\(\))
```

#### Pattern 3: Read-Only Configuration Gap（只读配置缺口）

**触发条件**：Servlet 的 `web.xml` 或 `@WebServlet` 中配置了 `readonly=false` 或未显式设置 `readonly`，但入口点枚举只记录了 GET 路径。

**检测步骤**：

```
1. 扫描 web.xml 中的 <servlet> 定义
2. 检查 <init-param> 中的 readonly 参数：
   - readonly=false 或未设置 readonly → PUT/DELETE enabled
   - allowPartialPut=true → 启用部分 PUT

3. 如果发现写入已启用，但入口点列表中没有 PUT/DELETE：
   → 这是严重遗漏，必须补充 doPut/doDelete 入口点
```

**关键关联**：在生成入口点时，将 Servlet 初始化参数与具体的 `doPut`/`doDelete` 方法行号关联。

### REST Framework Detection（REST 框架检测）

#### Pattern 4: Annotated Route with Multiple HTTP Verbs（同一路径多个 HTTP 方法注解）

**触发条件**：同一个 URL 路径有多个不同 HTTP 方法的注解。

**检测**：
```
Java Spring:
  @GetMapping("/users/{id}")
  @PostMapping("/users")
  @PutMapping("/users/{id}")
  @DeleteMapping("/users/{id}")

Python FastAPI:
  @app.get("/items/{item_id}")
  @app.post("/items")
  @app.put("/items/{item_id}")
  @app.delete("/items/{item_id}")

Node Express:
  router.get('/users', ...)
  router.post('/users', ...)
  router.put('/users/:id', ...)
  router.delete('/users/:id', ...)
```

**规则**：每个注解必须生成一个独立的入口点记录，不能合并。

### File Upload Detection（文件上传检测）

#### Pattern 5: Multipart File Upload（多部件文件上传）

**触发条件**：
```
Java:
  - request.getPart("filename")
  - request.getParts()
  - @RequestParam("file") MultipartFile

.NET:
  - Request.Files
  - IFormFile

Python:
  - request.files['file']
```

**检测正则**：
```
(java): \.getPart\(|\.getParts\(\)|MultipartFile
(csharp): Request\.Files|IFormFile
(python): request\.files\[
```

### Temp File in Servlet Method（Servlet 中的临时文件创建）

#### Pattern 6: Temporary File Creation in Write Method（写入方法中的临时文件创建）

**触发条件**：`doPut`/`doPost` 方法或写入类方法中包含临时文件创建逻辑。

**检测步骤**：
```
1. 在写入类 HTTP 方法（doPut/doPost/doDelete）中搜索：
   - File.createTempFile(...)
   - new File(tempDir, ...)
   - File.createNewFile()
   - tmpFile
   - tempFile

2. 如果找到，标记该入口点为：
   - temp_file_creation: true
   - temp_file_pattern: {detected pattern}
```

**正则表达式**：
```
(java): createTempFile|new\s+File\s*\(\s*temp|tempDir|contentFile|deleteOnExit
(csharp): Path\.GetTempPath|Path\.GetTempFileName
(python): tempfile\.|NamedTemporaryFile|mkstemp
```

## 检测流程

```
扫描阶段：
  1. Glob 所有 .java / .kt / .py / .js / .ts 文件
  2. Grep 匹配 Servlet 基类继承声明
  3. Grep 匹配 REST 注解
  4. Grep 匹配文件上传模式

分类阶段：
  - 对每个匹配的类，提取所有 HTTP 方法处理器
  - 对每个匹配的注解路由，提取 HTTP 方法
  - 识别文件上传端点

入口点生成阶段：
  - 为每个独立的 HTTP 方法处理器创建一条记录
  - 关联 Servlet 初始化参数
  - 标记 risk_direction
  - 关联临时文件创建模式

输出阶段：
  - 生成 entry-points.yaml
```

## 常见假阳性排除

- **Servlet 不覆写 `service()` 且不覆写任何 `doXxx`**：可能使用了框架自动处理，不需要枚举 HTTP 方法处理器（由框架分派）
- **接口定义中的 `doXxx` 方法**：仅接口定义不触发入口点，需要在实现类中查找
- **测试类中的 Servlet**：排除测试目录（`test/`、`tests/`、`*Test.java`）中的 Servlet
