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

## 前端 JavaScript 渲染 XSS Sink 枚举

### 背景

XSS sink 不仅存在于服务端模板（Blade `{!! !!}`、`Twig` `raw`、Jinja2 `|safe`），也广泛存在于前端 JavaScript 代码中。当 Web 应用通过 JavaScript 动态渲染来自后端 API 的数据时，DOM 操作函数可能将未转义的用户输入直接写入页面。枚举器如果只扫描服务端模板文件，会系统性遗漏此类攻击面。

### 扫描范围

**前端 JavaScript 代码目录**（通用路径，不限于特定项目）：
- `public/viewjs/**/*.js` — 前端页面逻辑
- `public/js/**/*.js` — 通用前端脚本
- `resources/js/**/*.js` — 前端资源脚本
- `assets/js/**/*.js` — 静态资源脚本
- 项目特有的前端目录（如有）— 根据项目画像中 `frontend_dirs` 字段补充

**注意**：不要将第三方库（`node_modules/`、`vendor/` 下的 JS 文件）纳入扫描范围。只扫描项目自身的业务代码文件。

### Sink 模式识别

枚举时应识别以下通用的 JavaScript XSS sink 模式，按类别分组：

#### 1. jQuery DOM 写入操作

jQuery 提供多个将字符串作为 HTML 解析并插入 DOM 的方法，均为 XSS 高危 sink：

| 方法 | 危险场景 | 搜索模式 |
|------|---------|---------|
| `.html()` | 将字符串作为 HTML 解析后写入元素 innerHTML | `\.\s*html\s*\(` |
| `.append()` / `.prepend()` | 将字符串追加/前置到元素内容 | `\.\s*(append\|prepend)\s*\(` |
| `.after()` / `.before()` | 在元素外部插入 HTML | `\.\s*(after\|before)\s*\(` |
| `.wrap()` / `.wrapAll()` | 用 HTML 包装元素 | `\.\s*wrap\s*\(` |
| `.replaceWith()` | 替换元素内容为 HTML | `\.\s*replaceWith\s*\(` |
| `.text()`（意外场景） | 当参数来自 `$(x).text()` 且 x 本身是 HTML 字符串时 | `\.\s*text\s*\(` |

#### 2. 第三方 Dialog/Modal 库的 HTML 渲染

多个第三方 UI 库接受 HTML 字符串参数并渲染到 DOM，与直接 `.html()` 调用等效：

| 库/函数 | 危险场景 | 搜索模式 |
|---------|---------|---------|
| `bootbox.alert()` | 将字符串拼接进 HTML alert 对话框 | `bootbox\.alert\s*\(` |
| `bootbox.confirm()` | 将字符串拼接进确认对话框 | `bootbox\.confirm\s*\(` |
| `bootbox.prompt()` | 将字符串拼接进输入对话框 | `bootbox\.prompt\s*\(` |
| `bootbox.dialog()` | 自定义对话框，支持 HTML 内容 | `bootbox\.dialog\s*\(` |
| `Ladda.`（按钮库） | Ladda 按钮的 spinner/文本渲染 | `Ladda\.create` |
| 其他 modal/notification 库 | 检查项目 package.json 或已知依赖 | 搜索 `\.html\s*\(` |

#### 3. 原生 DOM 操作

| 方法 | 危险场景 | 搜索模式 |
|------|---------|---------|
| `document.write()` / `document.writeln()` | 将字符串作为 HTML 写入文档 | `document\.(write\|writeln)\s*\(` |
| `element.outerHTML =` | 直接赋值元素的 outerHTML | `outerHTML\s*=` |
| `element.insertAdjacentHTML()` | 在元素指定位置插入 HTML | `insertAdjacentHTML\s*\(` |
| `element.outerHTML =` + 字符串拼接 | 同上但通过变量赋值 | `\.outerHTML\s*=` |

#### 4. 前端框架的原始 HTML 渲染

| 框架 | 危险场景 | 搜索模式 |
|------|---------|---------|
| Vue.js | `v-html` 指令绑定 | `v-html\s*=` |
| React | `dangerouslySetInnerHTML` | `dangerouslySetInnerHTML` |
| Angular | `DomSanitizer.bypassSecurityTrustHtml()` | `bypassSecurityTrustHtml` |
| 其他 SPA 框架 | 框架特有的原始 HTML 渲染 API | 搜索 `innerHTML\s*=` |

### 枚举执行步骤

1. **定位前端 JavaScript 目录**：根据项目画像确认前端代码所在目录，使用 Glob 工具收集所有 `.js` 文件
2. **搜索 Sink 模式**：对每类 sink 模式，使用 Grep 工具在收集的 JS 文件中搜索对应正则模式
3. **验证数据来源**：对每个命中点，向上追踪数据来源，确认数据是否来自用户输入（API 响应、URL 参数、表单输入、localStorage 等）
4. **过滤库代码**：排除来自 `node_modules/`、`vendor/` 的文件；排除测试文件（`*.test.js`、`*.spec.js`）
5. **构建数据流**：追踪从 API 输入到 DOM sink 的完整数据路径，记录 `data_flow.processing_chain`
6. **判断 auth_required**：前端 XSS 通常需要认证（攻击者需持有有效会话或 API Key 才能注入恶意数据），但某些场景（如公开页面评论、公开 API 返回的用户内容）可能无需认证

### 泛化规则

- **禁止使用特定项目名**：规则描述使用通用术语（"前端 JavaScript 文件"、"API 响应数据"），不得出现任何特定项目、文件名、函数名的引用
- **Sink 描述泛化**：以方法名模式（如 `.html()`、`bootbox.alert()`）描述 sink，不绑定到具体业务场景
- **数据流描述泛化**：追踪路径时使用"后端 API 响应"、"数据库字段"、"用户输入"等通用标签
- **输出 Feature ID 泛化**：使用 `FEAT-dp-{NNN}-js-xss-sinks` 格式，name 字段描述为"前端 JavaScript DOM XSS Sinks"，不引用特定项目
