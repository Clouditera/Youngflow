# Feature Trace Reference

## 概述

Feature trace 是将入口点与功能点（feature）关联起来的过程。每个功能点代表一个独立的业务逻辑或安全上下文。入口点通过数据流连接到功能点。

## 入口点与功能点的映射规则

### 规则 1: 同一 Servlet 的不同 HTTP 方法属于不同功能点

**场景**：当一个 Servlet 类处理多种 HTTP 方法时，每种 HTTP 方法应该映射到不同的功能点。

**原因**：不同 HTTP 方法触发的代码路径、数据处理逻辑和安全风险完全不同。

**示例**：
```
Servlet: org.apache.catalina.servlets.DefaultServlet
  - doGet()      → 功能点: feat-ei-007-static-resource-read
  - doPut()      → 功能点: feat-ei-XXX-static-resource-write
  - doDelete()   → 功能点: feat-ei-XXX-static-resource-delete
  - doPost()     → 功能点: feat-ei-XXX-static-resource-form-post
```

每个功能点应该有独立的：
- `entry_points` 行号列表（包含该方法对应的行号）
- `processing_chain`（描述该方法的具体数据流）
- `risk_level`（基于该方法的能力评估）

### 规则 2: 数据流路径必须与入口点方法对应

**场景**：在生成 `processing_chain` 时，数据流路径必须从入口点的实际方法开始。

**错误示例**：
```
entry_point: doPut() at line 603
processing_chain:
  - step: 1
    action: 解析请求路径
    function: getRelativePath()  # ❌ 这是 doGet 中的方法
    file: DefaultServlet.java
    line: 440
```

**正确示例**：
```
entry_point: doPut() at line 603
processing_chain:
  - step: 1
    action: 处理 PUT 请求
    function: doPut()
    file: DefaultServlet.java
    line: 603
  - step: 2
    action: 执行部分写入（创建临时文件）
    function: executePartialPut()
    file: DefaultServlet.java
    line: 654
  - step: 3
    action: 读取临时文件内容
    function: new FileInputStream(contentFile)
    file: DefaultServlet.java
    line: 665
```

### 规则 3: 写入方法的功能点必须覆盖文件操作

**场景**：对于涉及文件写入的 HTTP 方法（PUT、DELETE），功能点的 `code_locations` 必须包含实际执行写入的代码行。

**检测关键词**：
```
写入相关:
  - FileOutputStream
  - FileInputStream (when reading from temp file written by PUT)
  - createNewFile()
  - createTempFile()
  - deleteOnExit()
  - OutputStream.write()
  - RandomAccessFile
  - Files.write()

临时文件相关:
  - tempDir
  - contentFile
  - convertedResourcePath
  - File (temp directory construction)
```

### 规则 4: 功能点 ID 分配

**规则**：
- 同一 Servlet 的不同 HTTP 方法使用不同的功能点 ID
- 格式：`feat-ei-{seq}` 或 `feat-{perspective}-{seq}`
- 当修改现有功能点时，如果添加了之前未覆盖的方法，需要：
  1. 为新方法创建新的功能点 ID
  2. 在现有功能点的 `entry_points` 中补充该方法的行号
  3. 在 `processing_chain` 中为新方法添加独立的处理链

## 功能点与 GROUP 的关联

当一个 Servlet 的多个方法被分配到不同的功能点时，确保：
- 同一个 Servlet 类只需要在 GROUP 的 `shared_code_paths` 中列出一次
- 但 `functions` 字段应列出该类涉及的所有函数类型

**示例**：
```yaml
# 在 GROUP 中：
shared_code_paths:
  - file: java/org/apache/catalina/servlets/DefaultServlet.java
    functions:
      - doGet        # GET 路径
      - doPut        # PUT 写入路径
      - doDelete     # DELETE 路径
      - executePartialPut  # PUT 写入的核心实现
```

## 诊断检查清单

完成功能点枚举后，自查以下问题：

```
[ ] 是否为每个 HTTP 方法处理器（doGet/doPut/doPost/doDelete）创建了独立的 entry_point？
[ ] 每个 entry_point 的 processing_chain 是否从该方法的实际入口行开始？
[ ] 写入方法（doPut/doDelete）的功能点是否包含了实际的文件操作代码位置？
[ ] 临时文件创建逻辑是否被识别并关联到对应的写入方法？
[ ] 同一 Servlet 的不同方法是否被分配了不同的功能点 ID？
[ ] 如果现有功能点只覆盖了 GET 路径，是否补充了写入方法的功能点？
```

## CVE 案例: DefaultServlet PUT 方法遗漏

**问题回顾**：
- 现有功能点 `feat-ei-007` 描述了 `doGet()` 入口（line 500）
- `doPut()` 入口在 line 603，完全未被覆盖
- `executePartialPut()` 在 line 654-700，未在任何 processing_chain 中
- `doPut` 与 `doGet` 的 processing_chain 完全不同

**修复要求**：
1. 创建新的功能点或扩展现有功能点，为 `doPut()` 添加独立的 entry_point
2. 在 processing_chain 中描述 `doPut() → executePartialPut() → FileInputStream` 的数据流
3. 在 `code_locations` 中添加 `executePartialPut()` 的行范围
4. 在 GROUP-004 的 `shared_code_paths` 中确保 `executePartialPut` 被列出
