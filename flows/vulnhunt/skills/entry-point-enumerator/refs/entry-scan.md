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

### Flex 框架用户管理入口

Flex 类框架（如 Grav、October CMS 等）使用 `FlexIndex` / `FlexObject` 模式管理实体，user management 也不例外。

**必须搜索以下关键词组合**（任一命中即需追踪）：

| 关键词类别 | 具体关键词 |
|-----------|-----------|
| Flex 基础类 | `FlexIndex`, `FlexObject` |
| 用户管理类 | `UserIndex`, `UserObject`, `UserCollection` |
| 元数据操作 | `updateObjectMeta` |
| 用户名处理 | `filterUsername` |
| 用户存储 | `UserStorage`, `UserFileStorage`, `UserFolderStorage` |

**搜索策略**：
1. 先用 `FlexIndex\|FlexObject` 找到 Flex 目录（通常是 `{framework}/Flex/` 或 `{framework}/Common/Flex/Types/Users/`）
2. 对 Flex 用户管理目录下的每个 `.php` / `.ts` / `.java` 文件，搜索 `updateObjectMeta`、`createUser`、`registerUser`、`saveUser`
3. 追踪 `updateObjectMeta` 和 `filterUsername` 的调用链，确认是否有用户名唯一性验证路径

**输出格式扩展**：
```
flex | UserManagement.updateObjectMeta | UserIndex.php | 65 | Flex User Account Update
flex | UserAccount.create | UserCollection.php | 120 | Flex User Registration
flex | UserAccount.filterUsername | UserIndex.php | 45 | Username Normalization
```

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
