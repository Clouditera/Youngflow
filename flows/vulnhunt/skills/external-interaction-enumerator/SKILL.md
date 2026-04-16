---
id: vulai/external-interaction-enumerator
name: External Interaction Enumerator
description: 外部交互枚举技能 - 枚举系统与外部世界的所有交互点，包括网络请求、文件系统交互、进程调用、环境变量读取等外部数据交换。是识别攻击面和外部数据入口的核心步骤。
category: enumeration
tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
triggers:
  keywords:
    - 外部交互枚举
    - 外部数据入口
    - 文件操作入口
    - external interaction enumeration
    - external data entry
    - file operation entry
    - external-interaction-enumerator
  intentPatterns:
    - "(enumerate|discover|find|list).*?(external|outbound|network|file|system).*?(interaction|entry|call)"
    - "(发现|枚举|识别).*?(外部|网络|文件|系统).*?(交互|入口|调用)"
constraints:
  rateLimit: unlimited
  timeout: 600
---

# External Interaction Enumerator Skill

## 概述与边界

本技能负责枚举系统与外部世界的所有交互点，包括：
- **文件系统交互**：文件读写、临时文件、文件上传下载
- **网络交互**：HTTP 请求、DNS 查询、Socket 连接
- **进程交互**：命令执行、子进程调用
- **环境交互**：环境变量读取、系统配置访问

**核心原则**：所有外部数据交换点都是潜在的安全边界。外部数据进入系统的每一个位置都必须被枚举为独立功能点。

## 枚举范围

### 文件写入入口

**规则 1（写入入口独立枚举）**：文件写入操作必须作为独立的外部交互功能点枚举，不能将其与文件读取混为一个功能点。

**典型写入入口**：
- HTTP PUT / DELETE 请求处理器
- 文件上传端点
- 日志写入接口
- 缓存持久化接口
- 配置文件写入接口

**示例场景**：
```
HTTP PUT 请求 → Servlet.doPut() → File.write() / executePartialPut()
                          ↓
                 临时文件创建（temp file）
                          ↓
                 读取临时文件（PUT 完成后不删除）

这是一个完整的文件写入外部交互链，必须被完整枚举。
```

### 临时文件创建入口

**规则 2（临时文件高风险标记）**：当写入方法中包含临时文件创建逻辑时，必须标记为高风险外部交互。

**检测关键词**：
```
Java:
  - File.createTempFile(...)
  - new File(tempDir, ...)
  - File.createNewFile()
  - deleteOnExit()
  - contentFile
  - convertedResourcePath

.NET:
  - Path.GetTempPath()
  - Path.GetTempFileName()
  - FileOptions.DeleteOnClose

Python:
  - tempfile.NamedTemporaryFile()
  - tempfile.mkstemp()
  - tempfile.mktemp()
```

**风险原因**：临时文件创建引入了以下风险：
- 文件名可预测性（路径等价攻击）
- 文件永不过期（`deleteOnExit` 仅在 JVM 关闭时触发）
- 文件位置错误（写入到非预期目录）
- 文件内容可利用（被其他系统组件读取，如反序列化）

**枚举要求**：
```
当检测到写入方法 + 临时文件创建的组合时：
  1. 为写入方法创建外部交互功能点
  2. 标记: temp_file_creation: true
  3. 标记: risk_level: high
  4. 在 code_locations 中包含:
     - 写入方法入口行
     - 临时文件构造行
     - deleteOnExit 设置行（如果有）
     - 临时文件读取行（如果有）
```

### HTTP 写入方法枚举

**规则 3（PUT/DELETE 方法独立枚举）**：HTTP PUT、DELETE、PATCH 方法对应的处理方法（`doPut`、`doDelete`、`doPatch`）必须被独立枚举为外部交互功能点。

**与 entry-point-enumerator 的区别**：
- `entry-point-enumerator` 负责发现入口点的存在（哪些方法存在）
- `external-interaction-enumerator` 负责描述外部交互的数据流（写入/读取如何工作）

**枚举要求**：
```
对于每个 HTTP 写入方法处理器（如 doPut）：
  1. 确定该方法处理的外部数据（HTTP 请求体、Range 头、路径参数）
  2. 追踪数据如何写入文件系统：
     - 请求体 → 写入目标（文件/临时文件）
     - 中间处理步骤
  3. 识别危险模式：
     - 路径从请求中构造
     - 临时文件未及时清理
     - 写入位置可预测
```

### 文件上传外部交互

**规则 4（文件上传外部交互）**：处理 `multipart/form-data` 的端点是典型的外部交互点。

**检测特征**：
```
Java:
  - HttpServletRequest.getPart()
  - HttpServletRequest.getParts()
  - @RequestParam("file") MultipartFile
  - StandardServletMultipartResolver

.NET:
  - Request.Files
  - IFormFile

Python:
  - request.files['file']
  - UploadSet
```

### 反序列化危险点

**规则 5（反序列化外部交互）**：当文件写入后被其他组件读取并反序列化时，这是一个高风险的外部交互链。

**检测模式**：
```
1. 写入文件（PUT 端点）
2. 文件路径/名称可从外部控制
3. 文件写入到应用会读取的目录（如 session 目录）
4. 应用使用 Java 反序列化读取文件
→ 这是典型的反序列化 RCE 链
```

## 功能点元数据格式

```yaml
external_interaction:
  id: ext-{seq}
  type: file_write | file_read | network_request | command_execution
  entry_points:
    - file: path/to/file.java
      line: N
      method: methodName
  data_flow:
    input_format: {描述外部数据格式}
    processing_steps:
      - step: 1
        action: {动作描述}
        file: path/to/file.java
        line: N
        function: methodName
      # ... 完整的处理链
    output: {描述数据去向}
  temp_file:
    created: true | false
    location_pattern: {描述临时文件位置构造方式}
    cleanup: true | false  # 是否有清理机制
    cleanup_method: {deleteOnExit / finally / try-with-resources}
  risk_level: low | medium | high | critical
  risk_patterns:
    - path_from_request        # 路径从请求构造
    - temp_file_predictable    # 临时文件名可预测
    - temp_file_no_cleanup     # 临时文件无清理
    - temp_file_read_back      # 临时文件被读取
    - deserialization_chain    # 反序列化链
```

## 常见遗漏模式

| 遗漏模式 | 风险 | 正确做法 |
|---------|------|---------|
| PUT 方法只记录 URL 路由，未描述写入数据流 | 高 | 为 doPut 方法创建独立外部交互功能点，包含完整的写入链 |
| 临时文件创建被忽略 | 高 | 在写入方法的 processing_chain 中标记 temp_file_creation |
| deleteOnExit 被当作清理机制 | 中 | deleteOnExit 仅在 JVM 关闭时触发，不是有效的清理 |
| 写入方法和读取方法共享同一个功能点 | 中 | 写入和读取是不同的外部交互，应分配不同功能点 |
| servlet 的 readonly 参数未关联到具体方法 | 中 | readonly=false 时，doPut/doDelete 应标记为 enabled |

## 输出

生成 `external-interactions.yaml`：

```yaml
external_interactions:
  - id: ext-001
    type: file_write
    name: HTTP PUT 文件写入（临时文件路径等价）
    entry_points:
      - file: java/org/apache/catalina/servlets/DefaultServlet.java
        line: 603
        method: doPut
    data_flow:
      input_format: HTTP PUT body + Content-Range header
      processing_steps:
        - step: 1
          action: 处理 PUT 请求
          file: DefaultServlet.java
          line: 603
          function: doPut
        - step: 2
          action: 创建临时文件（路径从请求构造）
          file: DefaultServlet.java
          line: 654
          function: executePartialPut
        - step: 3
          action: 读取临时文件内容
          file: DefaultServlet.java
          line: 665
          function: new FileInputStream
    temp_file:
      created: true
      location_pattern: "path.replace('/', '.') in tempDir"
      cleanup: false
      cleanup_method: deleteOnExit  # 仅 JVM 关闭时触发，非有效清理
    risk_level: critical
    risk_patterns:
      - temp_file_predictable
      - temp_file_no_cleanup
      - deserialization_chain
```
