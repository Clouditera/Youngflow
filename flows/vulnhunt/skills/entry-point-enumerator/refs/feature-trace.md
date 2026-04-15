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
| high | Flex 用户管理中 updateObjectMeta/用户名处理缺少唯一性验证（可导致账户劫持/权限提升） |
| medium | 认证不一致（部分有部分无）；公开的批量/资源消耗型操作 |
| medium | Flex 用户对象权限默认值可被外部输入覆盖 |
| low | 设计为公开的只读（静态资源、健康检查）；认证完整的标准 CRUD |

### Flex 用户管理功能域的特殊检查

Flex 框架（如 Grav）使用 `FlexIndex` / `FlexObject` 模式管理用户账户。当功能域涉及 Flex 用户管理时（`UserIndex`、`UserObject`、`UserCollection` 等类），追踪必须包含以下安全检查：

#### 1. 用户名唯一性验证链

追踪 `updateObjectMeta` 的完整调用链，确认在设置用户名之前是否存在唯一性检查：

```
注册/更新入口 → validateUsername/createUser/updateObjectMeta
              → 是否调用 findByKey/findByUsername/exists？
              → 如果只调用 filterUsername 而无唯一性检查 → 标记为 potential_risk
```

**危险模式**：在 `updateObjectMeta` 或类似元数据更新方法中，只对用户名做规范化（filterUsername、trim、lowercase），但不查询数据库/索引确认该用户名是否已被占用。

**CVE 案例参考**：`UserIndex::updateObjectMeta` 对用户名做 `filterUsername()` 规范化后直接写入，未检查唯一性，导致账户劫持（攻击者注册与管理员同名的账户）。

#### 2. 权限继承与默认权限

追踪 Flex 用户对象的默认权限设置：

```
UserObject/UserIndex → getDefaultAuthorization/getConfig
                     → 是否设置了非预期的 admin/privileged 角色？
                     → 是否有 role/permission 默认值被外部输入覆盖？
```

#### 3. 认证凭证处理

追踪用户创建/更新流程中的凭证处理：

```
createUser/updateUser → password/salt/token 字段
                       → 是否使用弱哈希算法？
                       → 是否在日志/响应中暴露明文凭证？
```

#### 4. Flex 存储层安全性

Flex 用户管理通常有多种存储后端（FileStorage、FolderStorage 等）：

```
UserIndex → getStorage/getFlexDirectory
          → 存储路径是否可被外部控制？
          → 是否有目录遍历防护？
```

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
