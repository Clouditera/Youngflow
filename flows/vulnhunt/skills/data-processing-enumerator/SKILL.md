---
name: Data Processing Feature Enumerator
description: 数据处理功能枚举 - 追踪项目中所有数据解析与变换的完整链路，验证安全配置覆盖率。适用于枚举 XML/JSON/二进制等格式的解析功能点、追踪嵌套解析链、验证安全工厂覆盖率。Do NOT use this skill for vulnerability triage or exploit analysis — it only enumerates parsing features and traces parsing chains.
---

# Data Processing Feature Enumerator

## 本质问题

给定一个项目，完整枚举所有数据解析与变换的功能点，追踪解析链路，验证安全配置覆盖率。

这件事的难点不是找到"项目解析 XML"（grep `import xml` 就能发现），而是**追踪解析链路中安全配置失效的盲区**。盲区有三种来源：

### 1. 嵌套解析 / 二次解析

解析器 A 的输出作为解析器 B 的输入，形成解析链。这种链条在代码搜索中不可见——grep 只能找到每个解析器被调用的位置，看不到"这段 XML 从哪里来、来之前经历了什么"。

典型形态：
- **容器格式嵌套**：ZIP → XML（Office 文档内部）、PDF → XMP → XML、gzip 归档 → 内容文件
- **编码层叠**：JSON 字符串字段内嵌 Base64 编码的 XML、JWT payload 先 Base64 解码再 JSON 解析
- **协议包裹**：Protobuf `bytes` 字段内嵌序列化对象、消息队列消息体内嵌 JSON

安全意义：安全配置（XXE 禁用、实体展开限制等）通常配置在"最外层"解析器上，内层解析器常常被单独实例化，天然绕过了安全工厂。嵌套层数越多，漏网的可能性越高。

### 2. 安全工厂绕过

成熟项目通常封装了"安全工厂"——一个返回预先配置好安全参数的解析器实例的函数。直接实例化解析器类（`new DocumentBuilderFactory()`、`yaml.load()`）会绕过这层配置。

问题的本质是**覆盖率验证**，不是"工厂是否存在"：工厂存在但只有 80% 的实例化路径使用它，那 20% 就是漏洞入口。尤其是：
- 二次解析的实例化点（内层解析器因为离"主流程"远，容易被忽视）
- 异常处理路径、测试辅助代码中的直接实例化
- 条件分支：某些请求路径走工厂，某些不走

### 3. 动态分发导致的解析路径不可见

在插件系统、策略注册表、事件总线等动态分发架构中，"哪种数据交给哪个解析器"在运行时才确定。静态搜索能看到注册表查找，看不到实际的解析器选择。此类项目中，格式发现必须覆盖所有实现模块目录，不能只看主入口。

---

## 解析链诊断框架

面对一个解析调用点，用以下三个问题依次诊断，再决定追踪深度：

### 问题一：这是解析链的起点，还是中间环节？

- **起点**：数据来源于外部输入——HTTP 请求体、文件上传、消息队列消息、用户提供的文件路径
- **中间环节**：数据来源于另一个解析器的输出字段（存在二次解析）
- **判断方法**：追踪函数参数来源，向上找到数据进入系统的边界。如果向上追踪遇到另一个解析器，记录二次解析关系

中间环节的解析点应标记 `secondary_parsing: true`，并在追踪时优先检查其实例化方式——因为这里最容易出现安全工厂绕过。

### 问题二：解析器是如何被实例化的？

- **通过安全工厂/辅助函数获取** → 覆盖率可能完整，但仍需确认工厂本身配置了哪些安全参数、是否覆盖当前格式的威胁
- **直接 `new Parser()` 或 `Parser.getInstance()`** → 疑似安全工厂绕过，需确认工厂是否存在、此处是有意绕过还是遗漏
- **条件分支实例化（部分路径走工厂）** → 部分绕过，按高风险处理

所有直接实例化点必须找齐——工厂的价值取决于覆盖率，而不是工厂本身有多安全。

### 问题三：解析结果流向哪里？

- 流入模块动态加载、`eval`/`exec`、反射调用 → 代码执行路径，高危
- 流入 SQL 构建、HTML 渲染、命令拼接 → 注入路径，高危
- 流入文件路径构造 → 路径遍历路径，高危
- 仅用于数据转换和内存操作 → 较低风险，但仍需记录

这三个问题的答案共同决定功能点的风险等级和追踪优先级。执行层细节见工作上下文中指定的方法论文档。

---

## 执行流程

### 段 1：脚本扫描（确定性穷举）

**⚠️ 强制执行 — 必须在段 2 之前完成，不可跳过。**

读取上游 prescan 阶段预执行的扫描结果。验证以下文件是否存在于输出目录：

- `formats-summary.txt`（各类别文件数统计，~1KB）
- `formats-index.txt`（各类别文件:行号列表，不含代码内容）
- `formats-candidates.txt`（完整原始结果，仅调试用）

> 如果文件不存在（prescan 未执行或执行失败），跳过段 1 和段 2，直接执行阶段 A 的手动扫描。**禁止自行编写或执行扫描脚本**。
>
> **降级策略**：若 summary/index 文件缺失，进入全量手动扫描模式，不得因此跳过任何枚举步骤。

**读取顺序（强制）**：
1. 首先读取 `formats-summary.txt`（~1KB），了解各类别命中数量
2. 对需要深入的类别，用以下命令按类别提取：
   ```bash
   awk '/^[CATEGORY_NAME]$/{f=1;next} /^[/{f=0} f' "$OUTPUT_DIR/formats-index.txt"
   ```
3. 根据提取到的 `文件:行号`，用 Read 工具的 `offset`/`limit` 精准读取源文件
4. **禁止直接读取 `formats-candidates.txt` 或整体读取 `formats-index.txt`**

---

### 段 2：补盲搜索

**⚠️ 强制执行 — 段 1 完成后必须执行，不可跳过。即使脚本全部类别都有命中，也必须完整执行段 2 的全部子步骤。**

#### 子步骤 2a：静态盲区补盲（基于 0-files 类别）

1. 回顾段 1 的 `formats-summary.txt`，列出所有 `0 files` 的类别
2. 对每个 `0 files` 类别，按决策树判断：
   - 该类别对应的项目类型不在 `project_type` 中 → 跳过
   - 该类别为**核心类别** → **必须补盲，不受 Grep 次数限制约束**
   - 其他属于目标类型但 0 命中 → 执行 1 次 Grep，计入次数（≤ 3 次）

**数据处理切面核心类别**：

| 核心类别 | 说明 |
|----------|------|
| `SERIALIZATION` | 反序列化调用点（pickle、unserialize、ObjectInputStream 等） |
| `TEMPLATE_ENGINE` | 模板引擎调用（Jinja2、Twig、Thymeleaf、Handlebars 等） |
| `UNSAFE_PARSER_CONFIG` | 不安全解析器配置（XXE 开启、YAML load 等） |

**补盲 Grep 要求**：使用与脚本不同的关键词，基于项目命名风格，禁止重复脚本 pattern。

---

#### 子步骤 2b：动态格式分发专项检查（强制执行，不受 0-files 触发约束）

**无论脚本命中多少，必须主动检查以下模式**：
- 根据 Content-Type 或文件扩展名动态选择解析器的分发逻辑
- CMS/框架自定义包装类间接调用底层解析器（如自定义 `TemplateEngine` 封装 Twig）
- 框架隐式反序列化配置（非显式函数调用，如 Laravel Cookie serialize、Spring Session 序列化策略）

**执行方式**：最多 1 次针对性 Grep（不计入 2a 次数），或 Read 框架配置文件确认是否存在动态格式分发。

---

#### 子步骤 2c：命中结果可信度验证

从 index 提取到 `文件:行号` 后，Read 目标行时必须验证：
1. 目标行不在注释块内（行首无 `//`、`#`、`/*`、`*`）
2. 目标行不在测试文件内（路径不含 `test`、`spec`、`mock`、`fixture`、`__tests__`）
3. 目标行不是字符串常量内容（不被引号包裹）
4. 目标行是真实的解析/反序列化调用代码

不满足条件的命中标记为误报，不纳入后续阶段 A/B/C 的语义分析。

---
---

## 常见陷阱

### 关联格式被切断追踪

**现象**：ZIP 解析和 ZIP 内 XML 解析被分配给不同的追踪任务，各自产出独立卡片，但二次解析关系没有被记录
**原因**：拆分任务时只看格式类别，没有考虑嵌套关系
**正确做法**：识别存在二次解析关系的格式对，将关联格式合并到同一个追踪任务

### 把"工厂存在"等同于"覆盖率完整"

**现象**：发现项目封装了 `SecureXmlParserFactory`，认为 XML 解析已处理，不再追踪直接实例化点
**实际**：项目可能有 15 处 XML 解析，只有 12 处经过工厂
**正确做法**：工厂的存在是一个信号，但覆盖率验证是独立任务——必须搜索所有直接实例化点，逐一核实

### 动态分发项目只看主入口

**现象**：项目使用插件注册表，主入口只做路由转发，grep 主模块找不到实际的解析代码
**实际**：实际解析逻辑分散在 plugins/ 或 handlers/ 下的各个实现模块中
**正确做法**：项目画像标记了动态分发时，将所有实现目录纳入扫描范围，不能因为主入口没有解析代码就认为覆盖完整

### 文件读取截断导致行范围不准

**现象**：对大文件只读了前几百行，产出的 code_locations 行范围停在文件开头区域
**原因**：没有先搜索定位关键函数，直接从头读取
**正确做法**：对大文件，先用 grep 定位关键函数的起止行，再用 Read + offset 读取完整函数体

---

## SQL 执行检测（数据处理视角）

### 背景

除标准数据库节点（Postgres、MySQL、Microsoft SQL）外，数据处理类节点也可能内建 SQL 执行能力。此类节点不在传统数据库节点目录下，但其 action 文件中可能包含 SQL 查询逻辑。

**关键检测特征**：节点 action 文件中使用 `evaluateExpression` 处理 SQL 相关参数（`query`、`sql`、AlaSQL 等），并在字符串替换后将结果用于数据库查询操作。

### 检测步骤

#### 子步骤 1：穷举所有节点 action 文件

使用以下命令扫描节点目录下的所有 action 实现文件（排除测试文件）：

```bash
grep -rn "evaluateExpression" --include="*.ts" \
  packages/nodes-base/nodes/ \
  | grep -v "/test/" | grep -v "/spec/" | grep -v "/__tests__/"
```

#### 子步骤 2：筛选含 SQL 上下文的 evaluateExpression 调用

对步骤 1 结果，识别同时满足以下条件的文件：

1. 文件路径在 `nodes/` 目录下，且包含 `actions/` 子路径
2. 文件内容同时包含：
   - `evaluateExpression` 调用（表达式求值入口）
   - 至少一个 SQL 相关关键词：SQL 查询参数名（如 `query`、`sqlQuery`）、AlaSQL 相关引用（如 `alasql`、`AlaSQL`）、SQL 关键字替换（如 `.replace(` 与 SQL 字符串的组合）
3. **排除**已知的标准数据库节点路径：
   - `nodes/Postgres/`、`nodes/MySql/`、`nodes/Microsoft/Sql/`、`nodes/Oracle/`、`nodes/SQLite/`

### 识别标准

满足以下组合特征即视为非数据库节点的 SQL 执行功能点：

- **特征 A**：`evaluateExpression` 调用 + `query`/`sqlQuery` 参数获取（来源判定）
- **特征 B**：将表达式求值结果通过 `.replace()` 拼接到 SQL 字符串（替换模式判定）
- **特征 C**：文件位于 `nodes/<NodeName>/<version>/actions/` 且节点类型为数据合并/数据转换类（Merge、Join、Split、Concatenate 等）

**示例路径**（供枚举器参考，不作为硬编码排除目标）：
- `packages/nodes-base/nodes/Merge/v3/actions/mode/combineBySql.ts` — 使用 `evaluateExpression` 处理 `query` 参数，AlaSQL 执行

### 输出格式

对每个识别到的非数据库节点 SQL 执行点，输出 feature 条目：

```yaml
feature:
  id: "feat-dp-XXX"
  name: "SQL Query Execution (<NodeType>)"
  perspective: "data-processing"
  risk_level: "high"
  description: "<NodeType> 节点支持通过 SQL 查询处理数据，SQL 语句可包含 n8n 表达式，表达式求值结果直接替换到查询字符串中，存在注入风险。"
  entry_points:
    - type: "internal"
      file: "<relative/path/to/action.ts>"
      line: <line_number>
      caller: "<function_name>"
  data_flow:
    input_format: "SQL Query String"
    processing_chain:
      - step: 1
        action: "获取 SQL 查询参数"
        file: "<file>"
        line: <line>
        function: "getNodeParameter"
      - step: 2
        action: "表达式求值"
        file: "<file>"
        line: <line>
        function: "evaluateExpression"
      - step: 3
        action: "查询字符串拼接"
        file: "<file>"
        line: <line>
        function: "String.replace"
      - step: 4
        action: "SQL 执行"
        file: "<file>"
        line: <line>
        function: "<sql-executor>"
    output_format: "Query Results"
  security:
    auth_required: true
    security_mechanisms:
      - name: "参数化查询"
        coverage: "none"
        note: "该节点不支持参数化查询"
    potential_risks:
      - risk_type: "sql-injection"
        description: "表达式求值结果直接拼接到 SQL 字符串，可绕过参数化保护"
      - risk_type: "code-injection"
        description: "n8n 表达式可执行任意 JavaScript，SQL 执行上下文可能导致 RCE"
  discovered_by: "data-processing-enumerator"
  confidence: "medium"
```

### 常见误报排除

| 排除条件 | 说明 |
|----------|------|
| 路径含 `Postgres/`、`MySql/`、`Microsoft/`、`Oracle/`、`SQLite/` | 标准数据库节点，由专门 feature 覆盖 |
| 文件含 `test`、`spec`、`__tests__` | 测试代码，不计入生产代码 |
| `evaluateExpression` 用于非 SQL 上下文（如 JSON 构造、URL 拼接） | 无 SQL 相关关键词，不在本检测范围内 |
