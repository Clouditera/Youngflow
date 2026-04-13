# Flow 资产包

Flow 是自包含的目录，独立于引擎存在。运行时通过路径传入：

```bash
youngflow /path/to/your-flow/flow.yaml --work-dir /path/to/target
```

## 目录结构

```
your-flow/
├── flow.yaml              流水线定义（唯一入口）
├── .env                   模型凭证（可选）
├── agents/                Agent 身份提示词
│   └── default.md
├── skills/                Skill 方法论（每个一目录）
│   └── your-skill/
│       └── SKILL.md
├── tasks/                 Task 描述文件
│   └── your-task.md
└── schemas/               YAML Schema（可选）
```

## 快速创建

1. 复制 `example/` 目录
2. 修改 `flow.yaml` 中的 stages
3. 添加你的 skills、tasks、agents
4. 运行：`youngflow your-flow/flow.yaml`

## flow.yaml Schema

Schema 定义在 `src/flow.schema.yaml`，引擎启动时自动校验。

详细字段说明见项目根目录 [README.md](../README.md#flowyaml-参考)。
