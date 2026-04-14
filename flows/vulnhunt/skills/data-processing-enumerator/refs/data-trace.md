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

### 路由关联视图文件覆盖

当追踪涉及模板引擎渲染时（如 Blade 模板），**必须确保所有与已知路由关联的视图文件都被扫描**：

1. **交叉引用路由枚举结果**：读取 `perspective_1_route` 目录下的功能点卡片，从 `entry_points` 中提取所有 HTTP 路由及其对应的 handler/controller 文件
2. **追踪 handler → view 的映射**：在 handler 文件中查找渲染视图的调用（如 `$this->renderPage($response, 'viewname')` 或 `return view('viewname')`），确认对应视图文件的路径
3. **确保视图文件被扫描**：验证这些视图文件已出现在 XSS sink 扫描结果中。如果某个视图文件未被扫描（如只出现在路由枚举中但未出现在 data-processing 枚举中），将其纳入扫描范围
4. **记录到功能点卡片**：在 `code_locations` 中包含所有被扫描的视图文件（`code_type: parsing_entry`），在 `entry_points` 中记录对应的 route handler 入口

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
