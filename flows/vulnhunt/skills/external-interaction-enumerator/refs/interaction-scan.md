# External Interaction Scan Reference

## 检测模式

### File Write Entry Detection（文件写入入口检测）

#### Pattern 1: Temp File Creation with Path from Request（从请求路径构造临时文件）

**触发条件**：在写入方法中发现临时文件创建，且文件路径/名称来自请求数据。

**检测步骤**：
```
1. 扫描所有 HTTP 写入方法：
   - doPut, doPost, doDelete, doPatch

2. 在每个写入方法中搜索临时文件创建模式：
   a) File.createTempFile(...)
   b) new File(tempDir, variableName)
   c) variableName.replace('/', '.')  # 路径到文件名的转换
   d) createNewFile()

3. 检查临时文件路径构造中是否使用了请求数据：
   - request.getPathInfo()
   - request.getRequestURI()
   - path parameter
   - 请求头（如 Content-Range）

4. 如果满足以下全部条件，标记为高风险：
   - [ ] 写入方法 + 临时文件创建
   - [ ] 临时文件路径来自请求
   - [ ] deleteOnExit() 被调用但无其他清理
   - [ ] 临时文件被读取回内存（FileInputStream）
```

**正则表达式**：
```
# 临时文件创建
(java): \.createTempFile\(|new\s+File\s*\(\s*tempDir|
      contentFile|convertedResourcePath|deleteOnExit

# 路径到文件名的转换（典型漏洞模式）
(java): \.replace\s*\(\s*['\"][/'\\]['\"]['\"]\s*,\s*['\"][.']['\"]\s*\)

# 文件创建
(java): \.createNewFile\(\)
```

**代码片段示例**（需要识别的危险模式）：
```java
// 危险：路径从请求构造，替换 / 为 . 生成临时文件名
String convertedResourcePath = path.replace('/', '.');
File contentFile = new File(tempDir, convertedResourcePath);
contentFile.createNewFile();
contentFile.deleteOnExit();  // 仅 JVM 关闭时触发
```

#### Pattern 2: No Cleanup After Write（写入后无清理）

**触发条件**：文件写入完成后，没有及时删除或清理。

**检测步骤**：
```
1. 在写入方法中追踪文件句柄：
   a) FileOutputStream / FileInputStream 创建
   b) 文件写入完成后的代码
   c) 查找 close()、delete()、finally 块中的清理

2. 检查是否有以下清理模式：
   - finally { file.delete(); }
   - try-with-resources (自动关闭)
   - 写入完成后显式 delete()

3. 如果没有清理，检查 deleteOnExit：
   - deleteOnExit() 不算有效清理（仅 JVM 关闭时触发）
   → 标记为: cleanup: false
```

**正则表达式**：
```
# 有效清理
(java): \.delete\s*\(\)           # 显式删除
(java): finally\s*\{[^}]*delete    # finally 块中删除
(java): try\s*\([^)]*File.*?\)\s*\{  # try-with-resources

# 无效清理
(java): deleteOnExit\(\)(?!.*\bdelete\b)  # 只有 deleteOnExit，无其他清理
```

### HTTP Method Write Detection（HTTP 写入方法检测）

#### Pattern 3: doPut Method Without Entry Point（doPut 方法未被枚举为入口点）

**触发条件**：在代码中发现 `doPut` 方法，但对应的外部交互功能点不存在。

**检测步骤**：
```
1. 扫描所有 .java 文件中的 doPut 方法：
   - grep: "void\s+doPut\s*\("

2. 对每个发现的 doPut：
   a) 获取所在类名和方法行号
   b) 检查是否已有对应的 external_interaction 功能点
   c) 如果没有，创建新的外部交互功能点

3. 为 doPut 方法生成完整的数据流：
   - 起点: doPut() 入口行
   - 终点: 最后一个文件操作行
   - 中间步骤: 所有文件读取/写入调用
```

### Deserialization After Write（写入后反序列化）

#### Pattern 4: Written File is Deserialized（写入的文件被反序列化）

**触发条件**：写入的文件在后续被 `ObjectInputStream` 或类似机制读取。

**检测步骤**：
```
1. 识别文件写入点（PUT 方法）
2. 追踪文件路径传播：
   - 文件路径是否被传递到 session 管理器？
   - 文件是否写入到 session 目录？
   - session 加载时是否使用 ObjectInputStream？

3. 识别反序列化调用：
   - ObjectInputStream.readObject()
   - XMLDecoder.readObject()
   - YAML.load() / yaml.load()
   - json.loads() with pickle

4. 如果写入文件路径可控且文件被反序列化：
   → 这是一条完整的 RCE 链
   → 必须作为 critical 风险外部交互枚举
```

**正则表达式**：
```
(java): ObjectInputStream|readObject\(|XMLDecoder|\.load\s*\(
(python): pickle\.(load|loads)|yaml\.(load|unsafe_load)
```

### Servlet Parameter Correlation（Servlet 参数关联）

#### Pattern 5: Readonly Parameter Not Linked（只读参数未关联到方法）

**触发条件**：`web.xml` 中的 `readonly` 参数为 `false`，但外部交互枚举没有关联到 `doPut`/`doDelete`。

**检测步骤**：
```
1. 扫描 web.xml 中的 servlet 定义：
   grep: "readonly" in <init-param>

2. 获取 readonly 参数值：
   - readonly=false → PUT/DELETE 已启用
   - allowPartialPut=true → 部分 PUT 已启用

3. 检查对应的 Servlet 类：
   - 确认 doPut/doDelete 方法存在
   - 如果存在，为每个方法创建外部交互功能点
   - 关联 servlet 参数到功能点元数据
```

## 扫描流程

```
Phase 1: 识别写入方法
  1. Grep "doPut\s*\(" → 获取所有 PUT 处理器
  2. Grep "doDelete\s*\(" → 获取所有 DELETE 处理器
  3. Grep "doPatch\s*\(" → 获取所有 PATCH 处理器
  4. Grep "@PostMapping|@Post\s*\(|@RequestMapping.*POST" → 框架 POST 端点
  5. Grep "getPart\(|getParts\(" → 文件上传端点

Phase 2: 分析写入数据流
  对每个写入方法：
    1. 从方法入口开始，追踪数据流
    2. 记录所有文件创建/写入操作
    3. 识别临时文件创建模式
    4. 检查清理机制

Phase 3: 关联配置参数
  1. 扫描 web.xml / annotation 配置
  2. 将 readonly / allowPartialPut 等参数与写入方法关联
  3. 标记启用的写入能力

Phase 4: 生成外部交互功能点
  对每个写入方法 + 文件操作的组合：
    1. 创建 external_interaction 功能点
    2. 填充 data_flow (processing_chain)
    3. 标记 temp_file 相关字段
    4. 评估 risk_level

Phase 5: 交叉引用
  1. 检查是否存在写入后反序列化链
  2. 检查是否存在路径遍历链
  3. 检查临时文件是否写入到敏感目录
```

## 假阳性排除

- **框架自动处理的文件写入**：某些框架（如 Spring）封装了文件写入，入口点是框架方法而非业务代码。需要深入框架层分析实际的写入实现。
- **测试代码中的写入**：排除测试目录中的写入方法。
- **只读的 HTTP 方法**：如果 `readonly=true` 且 `allowPartialPut=false`，`doPut` 方法通常是被禁止的空实现，跳过。
- **有正确清理的临时文件**：`try-with-resources` 或 `finally` 块中有 `delete()` 调用的临时文件，风险降低。
