# Flow 资产包

Flow 是自包含的目录，独立于引擎存在。运行时通过路径传入：

```bash
youngflow /path/to/your-flow/flow.yaml --work-dir /path/to/target
```

## 目录结构

```
your-flow/
├── flow.yaml              流水线定义（唯一入口）
├── init.sh                初始化脚本（可选，约定）
├── .env                   模型凭证（可选）
├── agents/                Agent 身份提示词
│   └── default.md
├── skills/                Skill 方法论（每个一目录）
│   └── your-skill/
│       └── SKILL.md
├── tasks/                 Task 描述文件
│   └── your-task.md
├── extensions/            Pi 扩展（可选）
└── schemas/               YAML Schema（可选）
```

## init.sh 约定

如果 flow 根目录包含 `init.sh`，用户 clone 后应首先运行它。脚本负责：

1. **准备依赖** — 子模块初始化、扩展 npm install 等
2. **检查配置** — 验证 .env / 环境变量是否就绪，检测必要工具

```bash
cd your-flow/
./init.sh
```

脚本应当幂等（重复运行安全），检查失败时以非零退出码退出。

## 快速创建

1. 复制 `example/` 目录
2. 修改 `flow.yaml` 中的 stages
3. 添加你的 skills、tasks、agents
4. 运行：`youngflow your-flow/flow.yaml`

## flow.yaml Schema

Schema 定义在 `src/flow.schema.yaml`，引擎启动时自动校验。

详细字段说明见项目根目录 [README.md](../README.md#flowyaml-参考)。
