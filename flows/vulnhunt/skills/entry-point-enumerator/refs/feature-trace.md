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

### 视图文件关联记录

对于返回 HTML 页面的 Web 路由，必须追踪并记录对应的视图/模板文件：

1. **查找视图渲染调用**：在 handler 实现中查找渲染模板的调用，常见模式：
   - PHP/Laravel: `$this->renderPage($response, 'viewname')` 或 `return view('viewname')`
   - Python/Flask: `return render_template('viewname.html')`
   - Node.js/Express: `res.render('viewname')`
   - 其他框架同理，查找对应的模板渲染函数
2. **记录视图文件路径**：将视图文件的完整路径（相对于项目根目录）记录在功能点卡片的 `view_files` 字段中（见输出格式），便于后续数据处理阶段交叉引用
3. **覆盖同一路由的所有变体**：同一功能可能有多个视图（列表页、编辑页、新建页），确保每个视图都被记录

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

  view_files: []
  # 路由关联的视图/模板文件路径列表（如 "views/users.blade.php"）
  # 用于后续数据处理阶段交叉验证，确保视图文件被纳入 XSS 等攻击面分析

  related_features: []
  discovered_by: "entry-point-enumerator"
  confidence: "high"
```
