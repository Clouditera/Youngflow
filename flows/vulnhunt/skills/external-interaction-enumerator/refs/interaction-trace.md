# 交互追踪任务

## 任务目标

对一个功能域的所有外部交互点做深层代码追踪，生成一张标准化功能点卡片（FEAT-ei-*.yaml）。

## 输入

- 功能域名称和描述
- 交互点列表（交互类型、调用形式、文件、行号）
- 项目语言/框架
- 排除目录列表
- 输出目录路径

## 执行方法

### 调用者溯源

对每个外部交互点，**向上追踪 2-3 层调用链**至外部入口点，确定：

1. **触发入口**：HTTP handler / CLI 入口 / 定时任务 / 事件处理器
2. **用户输入可控性**：

| 参数来源 | 可控性 | 风险等级 |
|---------|--------|---------|
| 用户请求参数 | 用户可控 | 高 |
| 配置文件（需检查配置来源） | 配置可控 | 中 |
| 硬编码常量 | 不可控 | 低 |

**追踪规则**：
- 维护已访问函数集合，防止循环
- 多入口汇聚时记录所有入口点
- 超过 10 层未到达入口点 -> 标记"入口点未确定"，不截断

### 响应数据 Sink 追踪

对每个 HTTP 客户端调用，追踪其**响应数据去向**，识别是否流入危险 Sink（eval/exec/open/反序列化/文件路径构造/动态 URL 构造等）。

```
HTTP 客户端调用 -> 响应数据赋值给变量 X
    -> X 流入危险 Sink？-> response_sink_risk: high
    -> X 仅用于展示/日志？-> response_sink_risk: low
```

### 多入口点覆盖

当发现一个入口点对应的外部交互功能后，**搜索是否存在共享同一 sink 函数的其他入口点**。

- 对比各入口点的输入验证差异（路径净化、字段过滤、CSRF 等）
- 每个入口点独立建卡，缺少验证的入口点提升 `risk_level`
- 在 `related_features` 中互相引用

> 同一后端操作函数被多个入口点调用时，安全性取决于最弱的入口点。

### 确定 code_locations

**核心原则：code_locations 覆盖完整数据流路径上的所有文件。**

- 每一层涉及的代码文件都必须进入 code_locations
- 行范围必须是**完整函数体**（函数签名到闭括号），不是 grep 命中行 +/- N 行
- 用 Read 工具实际读取文件确认函数边界

**大文件处理（>200 行）**：
1. 用 Grep 定位目标函数的行号
2. 用 Read 的 offset/limit 分段读取确认函数起止
3. **禁止只读前 100 行就下结论**——漏洞代码可能在文件后半段

**常见遗漏模式**（必须避免）：

| 遗漏 | 后果 |
|------|------|
| 只记录交互调用文件 | 安全分析器看不到调用链上的验证逻辑 |
| 只记录 handler，不追踪工具函数 | 遗漏工具函数中的漏洞 |
| 只记录直接处理文件，不追踪封装层 | 遗漏封装层缺少验证的问题 |
| grep 命中后不 Read 文件 | 无法确认函数边界和上下文 |

### 自检清单

生成卡片前必须验证：
- [ ] **每个交互点的调用者都在 code_locations 中**
- [ ] **processing_chain 引用的文件都在 code_locations 中**
- [ ] **code_locations 行范围是完整函数体**（用 Read 确认过，不是猜测）
- [ ] **涉及 HTTP 客户端的交互标注了响应数据去向**
- [ ] **大文件（>200 行）确认读取了目标函数所在行**（不是只读了文件头部）

## 输出格式

写入 `{output_dir}/features/FEAT-ei-{NNN}-{short_name}.yaml`：

```yaml
feature:
  id: "feat-ei-{NNN}"
  name: "{功能域名称}"
  perspective: "external-interaction"
  risk_level: "{high/medium/low}"
  risk_rationale: "{具体原因}"
  description: "{功能描述}"
  language: "{语言}"

  entry_points:
    - type: "{触发入口类型}"
      path: "{路径/标识}"
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

  security:
    auth_required: {true/false}
    security_mechanisms:
      - name: "{机制名称}"
        coverage: "{full/partial/none}"
        location: "{文件:行号}"
    potential_risks:
      - risk_type: "{ssrf/sqli/rce/path_traversal/ldap_injection/...}"
        description: "{描述}"

  code_locations:
    - file: "{文件}"
      start_line: {起始行}
      end_line: {结束行}
      code_type: "{external_call/caller/business_logic/utility/wrapper}"

  related_features: []
  discovered_by: "external-interaction-enumerator"
  confidence: "high"
```
