# 解析链追踪方法论

## 任务目标

对指定数据格式追踪完整的解析链路，生成标准化功能点卡片（FEAT-dp-*.yaml）。追踪的完整度是第一优先级。

## 方法论

### 解析链追踪

从解析器入口出发，向下追踪完整调用链直到终止条件（叶子函数/环路/库边界）：

1. **定位解析器入口** — 找到实际调用解析器的代码位置
2. **向下追踪解析链** — 沿调用链向下，维护已访问函数集合检测环路
3. **识别二次解析** — 解析器 A 的输出是否作为解析器 B 的输入（如 ZIP 内 XML、PDF 中 XMP）
4. **追踪解析结果执行路径** — 解析结果的字段是否流入危险 sink（动态模块加载、函数调用、SQL/HTML/命令拼接）

### 安全配置覆盖率验证

不是"存在安全配置"就够了，而是要验证"所有代码路径都使用了安全配置"：

1. 找到安全工厂/安全配置方法
2. 搜索所有直接实例化解析器的代码
3. 对比：直接实例化是否全部经过安全工厂？条件分支是否导致部分路径绕过？
4. 配置必须精确到行号，无法定位则标记 `coverage: none`

### 表达式/查询引擎调用点

同一引擎在不同上下文中产生不同漏洞。必须追踪所有调用点的上下文：SQL 拼接→注入，HTML 渲染→XSS，文件路径→遍历，命令构建→注入。为每个危险上下文创建独立功能点。

### 安全防护层发现

搜索沙箱包装、输入净化器、原型链保护、全局对象隔离等防护代码，纳入 `code_locations`（`code_type: security_boundary`）。

### code_locations 要求

- 安全关键文件（沙箱、净化器、AST 访问器、权限检查）必须覆盖**完整实现范围**
- 调度/转发中间层文件必须纳入（`code_type: dispatch_layer`）
- 行范围必须是完整函数体，用 Read 确认
- 大文件先搜索定位再分段 Read，禁止只读文件头部

### 大型源文件的完整覆盖规则

对于以下类型的源文件，**必须覆盖完整文件范围**，不得仅覆盖文件头部区域：

- 嵌入式脚本引擎的核心源文件（如 `eval.c`、`script.c`、`script_lua.c`、`function_lua.c` 等）
- 包含内部函数/回调/生命周期管理函数的命令处理文件
- 文件总行数超过 300 行的数据处理关键文件

**根因**：这类文件中，关键的内部函数（如垃圾回收、错误处理、命令路由回调等）通常分布在文件的中间和尾部区域。仅覆盖前 200 行会遗漏占总行数 50% 以上的代码区域，导致分析阶段无法关联到实际的漏洞调用点，从而产生误判（FP/NP）。

**枚举执行步骤**：

1. 对上述类型的文件，先执行 `wc -l <file>` 确认文件总行数
2. 如果超过 300 行，必须先执行 `grep -n "^[a-zA-Z_].*(" <file>` 扫描所有函数定义行
3. 根据函数分布确定覆盖策略：
   - 对于包含多条命令处理路径、回调函数、GC 函数的文件，**覆盖完整文件**（`start_line: 1, end_line: <total_lines>`）
   - 优先选择多个小范围覆盖，而非单个大范围，但必须确保没有未覆盖的"缝隙区域"
4. 确认每个 code_locations 区域的 `end_line` 之后有合理的函数边界（不是随意截断）
5. **禁止出现**：单个 code_locations 区域的 end_line 不超过文件总行数的 40% 且未覆盖任何中间/尾部区域函数的情况

**验证方法**：枚举完成后，对照 file 行范围检查 code_locations。如果发现 code_locations 的 end_line 明显小于文件总行数（< 40%），则视为覆盖不完整，需要补充。

### C/C++ 数据类型实现源文件的双区域覆盖

对于使用 C 语言实现数据类型解析的项目（如 Redis/Nerimano），数据类型实现源文件（如 `t_*.c`）存在**双区域结构**，两个区域都包含数据处理的关键代码：

#### 双区域结构

| 区域 | 内容 | 典型行号范围 |
|------|------|-------------|
| 区域 1（头部） | RDB 序列化/反序列化、内部数据结构定义、工具函数 | 文件开头 ~2000 行 |
| 区域 2（命令区） | 命令处理函数实现（`*Command`、`*GenericCommand`） | ~2000 行至文件末尾 |

**典型案例**：Redis `t_stream.c`（4557 行），xackdelCommand 漏洞函数位于第 3185 行，处于区域 2。枚举器若仅覆盖前 500 行（区域 1 开头），将完全遗漏该漏洞。

#### 识别方法

1. **文件模式**：`t_*.c` 命名模式，或项目中用于实现数据类型解析/命令处理的源文件
2. **文件规模**：超过 1000 行
3. **命令函数签名**：`void *Command(client *c)` 或 `void *GenericCommand(client *c, ...)`

#### 覆盖操作

1. **先定位**：执行 `wc -l <file>` 和 `grep -n "^void.*Command\|void.*GenericCommand" <file>`，确认命令处理区域是否存在
2. **扩展行范围**：如果命令处理函数存在，code_locations 必须覆盖到命令区域（通常是文件后半部分），不得在区域 1 末尾截断
3. **分段读取**：用 `Read + offset` 分段读取，禁止只读文件头部
4. **禁止固定行数截断**：不能假设"前 500 行包含所有相关代码"，必须根据实际文件结构确定覆盖范围

### risk_level 原则

枚举器不应因发现防护就降低风险等级（防护有效性验证是分析器的职责）。以下条件强制 `high`：

- 用户上传文件经过 XML/SVG 解析
- Office 文档解析（内嵌 XML）
- 存在二次解析
- 解析结果用于动态加载/代码执行
- 直接实例化解析器（绕过安全工厂）

### 完成自检

- 安全关键文件的 code_locations 是否覆盖完整实现范围
- secondary_parsing 字段是否准确
- 调度/转发层文件是否纳入
- **大型源文件（>300 行）是否覆盖了完整文件范围，尾部区域的函数定义是否被遗漏**

## 输出格式

写入 `{output_dir}/features/FEAT-dp-{NNN}-{short_name}.yaml`：

```yaml
feature:
  id: "feat-dp-{NNN}"
  name: "{格式名称} Parsing"
  perspective: "data-processing"
  risk_level: "{high/medium/low}"
  risk_rationale: "{具体原因}"
  description: "{描述}"
  language: "{语言}"

  entry_points:
    - type: "{入口类型}"
      path: "{路径}"
      file: "{文件}"
      line: {行号}

  data_flow:
    input_format: "{输入格式}"
    processing_chain:
      - step: 1
        action: "{处理动作}"
        file: "{文件}"
        line: {行号}
        function: "{函数名}"
    output_format: "{输出格式}"
    secondary_parsing: {true/false}
    secondary_format: "{二次解析格式，如有}"

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
      code_type: "{parsing_entry/secondary_parsing/security_boundary/dispatch_layer}"

  related_features: []
  discovered_by: "data-processing-enumerator"
  confidence: "high"
```
