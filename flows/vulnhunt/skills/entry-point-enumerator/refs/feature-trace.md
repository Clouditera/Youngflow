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

### 业务逻辑安全追踪

在追踪过程中，如果遇到以下类型的对象/类，**必须继续深入追踪其数据管理方法**，而不能以"入口文件已覆盖"为由在 handler 层面停止：

**数据管理层识别特征**：
- 类名包含 `Index`、`Storage`、`AbstractFilesystem`、`ObjectManager` 等数据存储抽象层标识
- 方法签名包含 `create`、`update`、`setMeta`、`updateMeta`、`filter*`、`normalize*` 等对象元数据操作
- 这类类通常是框架级别的抽象（如 Flex 框架、ORM 抽象层），而非业务层 handler

**必须追踪的具体模式**：

1. **用户数据管理类**：
   - 识别：处理用户对象创建/更新的类（方法包含 `create`、`update`、`save`、`setMeta`、`filterUsername` 等）
   - 追踪要求：必须读取完整的 `create`/`update`/`setMeta` 方法体，确认是否存在：
     - 唯一性校验（uniqueness check）
     - 权限校验（authorization）
     - 输入规范化（normalization）
   - 如果方法体内调用了 `filter*` 或 `normalize*` 方法但没有对应的唯一性/权限校验，这是一个风险点

2. **文件存储管理类**：
   - 识别：处理对象键到文件路径映射的类（方法包含 `getPathFromKey`、`create`、`update`、`delete` 等）
   - 追踪要求：必须读取完整的路径构造方法，确认是否存在路径规范化（traversal prevention）
   - 如果只做了关键字过滤而没有完整路径校验，这也是一个风险点

**code_locations 行范围规则（针对数据管理层）**：
- 不能只覆盖文件的前 N 行就结束
- 必须读取到实际处理逻辑所在的行（通常是方法体内部，而非类的顶部）
- 如果类中有关键方法（如 `updateObjectMeta`、`setMeta`、`filterUsername` 等），code_locations 的行范围必须覆盖这些方法的完整函数体
- 判断方法：用 Read 工具定位方法签名行号，然后找到方法闭括号所在行，以这两个行号作为 `start_line` 和 `end_line`

**风险评估扩展**：
| 等级 | 判定 |
|------|------|
| high | 数据管理层方法中，写操作（create/update/setMeta）缺少唯一性校验或权限校验 |
| high | 路径构造使用了关键字过滤但缺少完整的规范化逻辑 |
| medium | 校验逻辑存在但不完整（如只检查空值、不检查格式） |

### 风险评估

| 等级 | 判定 |
|------|------|
| high | 无认证 + 写操作/敏感数据/代码执行/文件操作；路径含通配符参数的写操作；内部代码执行引擎 |
| medium | 认证不一致（部分有部分无）；公开的批量/资源消耗型操作 |
| low | 设计为公开的只读（静态资源、健康检查）；认证完整的标准 CRUD |

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
