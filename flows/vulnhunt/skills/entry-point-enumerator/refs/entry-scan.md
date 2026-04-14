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

### Servlet 容器实现类

对于 Java Servlet 容器项目（如 Tomcat、Jetty 等），除了扫描容器框架组件（Wrapper、Context、FilterChain 等）外，还必须扫描框架层之下的具体 Servlet 实现类。这些实现类（如 DefaultServlet、InvokerServlet）是容器处理实际请求的执行者，是 RCE 的重要攻击面。

**识别项目类型**：查找 `javax.servlet.HttpServlet` 或 `jakarta.servlet.HttpServlet` 的引用，或查找 `servlet/` 子目录存在。

**扫描规则**：

1. 扫描项目中所有 `servlet/` 子目录
2. 在这些目录中查找继承 `HttpServlet` 的具体实现类
3. 重点关注：
   - `DefaultServlet`（处理 GET/HEAD/POST/PUT/DELETE 等标准 HTTP 方法）
   - `InvokerServlet`（处理未映射到具体 Servlet 的请求）
   - 其他以 Servlet 方式注册、处理用户请求的类
4. 验证方式：确认类中有 `@Override` 的 `doGet`、`doPost`、`doPut`、`doDelete`、`service` 等方法

**注意事项**：
- Servlet 实现类是容器级别的入口（而非应用级别的路由），应与框架组件（StandardWrapper、StandardContext 等）一同枚举
- 即使项目有完善的容器框架组件枚举，Servlet 实现类本身也应单独列出，因为漏洞可能存在于具体的 Servlet 处理逻辑中

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
