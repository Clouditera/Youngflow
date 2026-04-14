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

### 动态分发入口

如果项目存在动态分发架构（入口通过运行时配置路由到不同实现）：

1. 分发入口本身记录为入口点，标记"动态分发"
2. 实现目录下的每个模块也记录为潜在入口点
3. 实现模块中的入口标记"由 {dispatch_entry} 动态调用"

### 数据管理层入口（框架抽象层）

如果项目使用了 Flex 框架或类似的 ORM/对象存储抽象层（如 Laravel Eloquent、Doctrine、SilverStripe ORM），还需要额外扫描以下入口点类型：

**扫描目标**：
- 数据索引类（类名包含 `Index`、`UserIndex`、`ObjectIndex` 等）：记录对象元数据的查询和更新方法
- 存储实现类（类名包含 `Storage`、`FolderStorage`、`AbstractFilesystem` 等）：记录对象持久化方法
- 过滤器/规范化类（方法包含 `filter*`、`normalize*` 等）：记录输入校验逻辑

**搜索模式**：
1. 搜索类文件（按语言约定：`.php`、`*.java`、`*.py` 等），匹配 `class.*Index` 或 `class.*Storage`
2. 在这些类中搜索 `function create`、`function update`、`function setMeta`、`function updateMeta`
3. 对于 Flex 框架：搜索 `extends AbstractIndex` 或 `extends FolderStorage` 的类

**记录为入口点时**：
- 入口类型标记为 `internal`（框架内部入口）
- caller 字段记录调用来源（如 `buildIndex`、`Flex loader`）
- entry_points 中包含关键数据操作方法（create/update/setMeta）

**验证要求**：
- 确认是真实类定义而非接口或 trait
- 确认方法签名有实际实现（非 abstract 方法）

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
