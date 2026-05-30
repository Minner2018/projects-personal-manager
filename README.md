# projects-personal-manager

项目集个人管理系统用于供个人在本地集中管理代码项目集。

系统只负责项目索引、项目理解、AI 上下文组织和 AI 协作协议，不接管各项目自身的构建、测试、发布、依赖管理或 Git 仓库。

## 核心目录

- `projects/`：代码项目目录。每个接入项目至少需要提供 `.project.yaml`。
- `programs/`：项目组目录。每个项目组使用 `_program.yaml` 描述成员和组内项目关系。
- `human/`：适合人类阅读的材料、文档或资源。
- `ai/`：供 AI 读取的全局上下文、角色入口、工作流程、项目摘要、任务记录和长期记忆。
- `scripts/`：维护索引、项目组、AI 摘要、一致性检查和并发检查的脚本。
- `system-docs/`：仅存放该系统本身的相关文档。

## 接入项目

在 `projects/<project-id>/` 下创建 `.project.yaml`。

最小示例：

```yaml
id: example_project
name: 示例项目
status: active
ownership: owned
```

推荐字段：

```yaml
description: null
tech_stack: null
main_entries: null
commands: null
relations: null
```

## 常用脚本

- `bun run registry`：生成 `registry.yaml`。
- `bun run registry:example`：生成 `registry.example.yaml`。
- `bun run programs`：同步项目组 `_program.yaml` 中的 `projects` 字段。
- `bun run ai-projects`：生成或补全 AI 项目摘要。
- `bun run check`：运行一致性检查和并发检查。
- `bun run check:consistency`：检查核心文件之间的一致性。
- `bun run check:concurrency`：检查 AI 进行中任务和文件锁之间的并发冲突。
- `bun run typecheck`：检查脚本类型。

## 示例内容

以下文件或目录仅为示例，用于展示系统结构和接入方式，不代表真实项目、真实任务、真实材料或真实长期记忆：

- `projects/example_project/`
- `registry.example.yaml`
- `programs/example_program/`
- `human/projects/example_project/`
- `human/未分类/示例文档.md`
- `ai/projects/example_project.md`
- `ai/tasks/example_task.md`
- `ai/memory/global.example.md`
- `ai/memory/projects/example_project.md`

## AI接入

如果使用 codex 开发，直接使用该项目中的 AGENTS.md 即可。若使用其他 AI，应在对应的规则文件中填入：

```markdown
请先阅读并遵守本项目根目录的 AGENTS.md。
```

## 提交策略

真实项目、真实项目组、真实 AI 任务和真实 AI 记忆默认只保留在本地。example 相关内容可以提交。

详细规则见 `.gitignore` 和 `system-docs/` 中的设计文档。
