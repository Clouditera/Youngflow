# Flex 存储 Key-Path 安全分析方法论

## 任务目标

在 Flex 存储类中，完整枚举 key→path 转换链路的所有函数，验证每个函数是否有路径遍历防护，并输出标准化功能点卡片。

## 适用范围

- 使用 Flex/CMS 框架的项目（如 Grav、OctoberCMS、Drupal）
- 存在 `*Storage`、`*FilesystemStorage`、`*Store` 等文件系统存储抽象类的项目
- 使用 key→path 映射进行数据持久化的场景

## 关键概念

### Flex 存储 key→path 转换链路

Flex 存储系统通过"存储键"（storage key）定位和管理持久化数据。其 key→path 转换链路通常包含以下函数：

1. **normalizeKey(key)** — 对外部输入的 key 做规范化（通常：大写转小写、去除空格）
2. **validateKey(key)** — 验证 key 格式（通常：正则匹配禁止字符）
3. **parseKey(key)** — 将 key 分解为子组件（如前缀、哈希、文件扩展名）
4. **getPathFromKey(key)** / **getStoragePath(key)** — 将 key（或其子组件）拼接为完整文件系统路径（通常：sprintf 路径模板）
5. **getFilePath(key)** — 直接构造文件路径（通常已有防护）

### "漏洞窗口"模型

```
外部输入 (user key)
  ↓
normalizeKey()  ← 只做大小写转换，不净化 ../ 序列
  ↓
parseKey()      ← 将 key 分解，不验证遍历序列
  ↓
getPathFromKey()  ← 直接 sprintf 插值，无 realpath 验证
  ↓
sprintf("{FOLDER}/{KEY}/{FILE}{EXT}", ...)
  ↓
目录穿越漏洞！
```

当 `normalizeKey` 只做 case conversion（`mb_strtolower`/`strtolower`），且 `getPathFromKey`/`parseKey` 直接将 key 注入 sprintf 路径模板而不做遍历检测时，key 中的 `../` 序列会逃逸出目标目录。

## 检测方法

### 步骤 1：定位 Flex 存储类

搜索以下文件名模式：

```bash
# 优先搜索路径
grep -rn "class.*extends.*FilesystemStorage\|class.*extends.*AbstractStorage" --include="*.php"
grep -rn "class.*Storage.*extends\|trait.*Storage\|implements.*FlexStorageInterface" --include="*.php"
```

在 PHP 中，存储类通常位于：
- `system/src/{Framework}/{Flex,CMS}/Storage/`
- `src/{Storage,Store,Filesystem}/`
- `libraries/{Flex,CMS}/Storage/`

### 步骤 2：枚举 key→path 转换链路

对每个存储类，逐一检查以下函数是否存在，并读取完整函数体：

| 函数名模式 | 作用 | 查找命令 |
|-----------|------|---------|
| `normalizeKey` | key 规范化 | `grep -n "function normalizeKey" *.php` |
| `validateKey` | key 格式验证 | `grep -n "function validateKey" *.php` |
| `parseKey` | key 分解 | `grep -n "function parseKey" *.php` |
| `getPathFromKey` | key→path 转换 | `grep -n "function getPathFromKey" *.php` |
| `getStoragePath` | key→storage path | `grep -n "function getStoragePath" *.php` |
| `getMediaPath` | key→media path | `grep -n "function getMediaPath" *.php` |
| `getFilePath` | 路径构造（通常已覆盖） | `grep -n "function getFilePath" *.php` |

### 步骤 3：安全分析

对链路中的每个函数，检查以下防护措施：

| 防护类型 | 检测关键词 | 无防护指标 |
|---------|-----------|-----------|
| 路径遍历净化 | `checkFilename`、`filterFilename`、`sanitizePath` | 仅 `strtolower`/`mb_strtolower` |
| 正则格式验证 | `preg_match.*[\/?*:;{}\\][...]` | 无验证或验证不含 `/` 或 `\` |
| 路径规范化 | `realpath`、`Path::normalize`、`Utils::normalizePath` | 直接 sprintf 插值 |
| 目录约束 | `str_starts_with($path, $baseDir)`、`chroot` | 无边界约束 |

**关键检查点**：

1. `normalizeKey` 的实现是否只做 case conversion（`mb_strtolower`）而**不检查** `../` 或 `..\`？
2. `validateKey` 是否被 `getPathFromKey` / `parseKey` 调用？（可能有 `validateKey` 但未被使用）
3. `getPathFromKey` 是否直接用 sprintf 插值 key 或其子组件？
4. `parseKey` 分解后的组件是否被单独用于路径拼接？
5. 路径模板（`dataPattern`、`{FOLDER}/{KEY}/{FILE}{EXT}`）是否被验证在目标目录范围内？

### 步骤 4：验证完整行范围

每个函数的 `code_locations` 必须覆盖完整函数体：

```yaml
code_locations:
  - file: "{path}/FolderStorage.php"
    start_line: 206       # normalizeKey 起点
    end_line: 213         # normalizeKey 终点（含 }）
    code_type: parsing_entry
  - file: "{path}/FolderStorage.php"
    start_line: 334       # parseKey 起点
    end_line: 345         # parseKey 终点（含 }）
    code_type: parsing_entry
  - file: "{path}/FolderStorage.php"
    start_line: 315       # getPathFromKey 起点
    end_line: 327          # getPathFromKey 终点（含 }）
    code_type: parsing_entry
  - file: "{path}/AbstractFilesystemStorage.php"
    start_line: 206       # normalizeKey 起点
    end_line: 213         # normalizeKey 终点
    code_type: parsing_entry
```

**常见错误**：只覆盖基类的 `normalizeKey` 而遗漏子类的覆盖（反之亦然）。父子类都要检查。

## 典型代码模式

### 漏洞模式（需检测）

```php
// AbstractFilesystemStorage.php - 弱规范化
public function normalizeKey(string $key): string
{
    if ($this->caseSensitive === true) {
        return $key;  // 直接返回，无遍历检测
    }
    return mb_strtolower($key);  // 只做大小写转换
}

// FolderStorage.php - 直接插值
public function getPathFromKey(string $key): string
{
    $parts = $this->parseKey($key);
    $options = [
        $this->dataFolder,   // {FOLDER}
        $parts['key'],        // {KEY} — 未验证的 key 直接注入
        $parts['key:2'],      // {KEY:2}
        $parts['file'],       // {FILE}
        $this->dataExt        // {EXT}
    ];
    return sprintf($this->dataPattern, ...$options);  // sprintf 插值
}
```

### 安全模式（对比）

```php
// 安全示例：validateKey 在调用链中被使用
public function getPathFromKey(string $key): string
{
    if (!$this->validateKey($key)) {
        throw new InvalidArgumentException("Invalid storage key");
    }
    // ...后续逻辑
}

// 安全示例：使用 realpath 规范化
$path = realpath(sprintf($this->dataPattern, ...));
if ($path === false || !str_starts_with($path, $this->dataFolder)) {
    throw new RuntimeException("Path traversal detected");
}
```

## 输出格式

写入 `{output_dir}/features/FEAT-dp-{NNN}-flex-storage-key-path.yaml`：

```yaml
feature:
  id: "feat-dp-{NNN}"
  name: "Flex Storage Key-Path 安全"
  perspective: "data-processing"
  risk_level: "{high/medium/low}"
  risk_rationale: "{具体分析}"
  description: |
    Flex 存储 key→path 转换链路的完整覆盖分析。
    包含 normalizeKey、parseKey、getPathFromKey、getStoragePath 等函数。
  language: "PHP"

  entry_points:
    - type: "storage_layer"
      file: "{path}/AbstractFilesystemStorage.php"
      line: 206
      function: "normalizeKey"
    - type: "storage_layer"
      file: "{path}/FolderStorage.php"
      line: 334
      function: "parseKey"
    - type: "storage_layer"
      file: "{path}/FolderStorage.php"
      line: 315
      function: "getPathFromKey"

  data_flow:
    input_format: "用户输入的存储键（username、storage_key 等）"
    processing_chain:
      - step: 1
        action: "key 规范化（case conversion）"
        file: "{path}/AbstractFilesystemStorage.php"
        line: 206
        function: "normalizeKey"
      - step: 2
        action: "key 分解"
        file: "{path}/FolderStorage.php"
        line: 334
        function: "parseKey"
      - step: 3
        action: "key→path 转换（sprintf 插值）"
        file: "{path}/FolderStorage.php"
        line: 315
        function: "getPathFromKey"
    output_format: "文件系统绝对路径"
    secondary_parsing: false

  security:
    auth_required: {true/false}
    security_mechanisms:
      - name: "validateKey"
        coverage: "{full/partial/none}"
        location: "{path}/AbstractFilesystemStorage.php:221-224"
        note: "正则验证 key 格式，但 getPathFromKey 可能未调用"
      - name: "realpath 规范化"
        coverage: "none"
        location: ""
        note: "getPathFromKey 直接 sprintf 插值，无 realpath 验证"
    potential_risks:
      - risk_type: "path_traversal"
        description: "normalizeKey 只做大小写转换，getPathFromKey 直接将 key 注入 sprintf 路径模板，若 key 包含 ../ 序列会逃逸目标目录"

  code_locations:
    - file: "{path}/AbstractFilesystemStorage.php"
      start_line: 206
      end_line: 213
      code_type: parsing_entry
    - file: "{path}/FolderStorage.php"
      start_line: 334
      end_line: 345
      code_type: parsing_entry
    - file: "{path}/FolderStorage.php"
      start_line: 315
      end_line: 327
      code_type: parsing_entry

  related_features: []
  discovered_by: "data-processing-enumerator"
  confidence: "{high/medium/low}"
```

## 常见陷阱

### 只覆盖父类，遗漏子类

`normalizeKey` 在 `AbstractFilesystemStorage`（父类）中定义，但 `getPathFromKey` 在 `FolderStorage`（子类）中覆盖。只读父类会遗漏子类特有的路径构建逻辑。

### validateKey 存在但未被调用

`validateKey` 可能实现了完整的路径遍历防护，但 `getPathFromKey` 直接调用 `parseKey` 而绕过 `validateKey`。必须确认防护函数在调用链中被实际使用。

### 只覆盖 getFilePath，遗漏 getPathFromKey

`getFilePath` 通常在基类中且已有路径规范化覆盖。但 `getPathFromKey` 是子类覆盖，两者路径模板和插值方式可能不同。必须将两者都覆盖。
