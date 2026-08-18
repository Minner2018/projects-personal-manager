# projects-personal-manager

项目集个人管理系统用于供个人在本地集中管理代码项目集。

系统只负责项目索引、项目理解、AI 上下文组织和 AI 协作协议，不接管各项目自身的构建、测试、发布、依赖管理或 Git 仓库。

## 核心目录

- `projects/`：代码项目目录。每个接入项目至少需要提供 `.project.yaml`。
- `programs/`：项目组目录。每个项目组使用 `_program.yaml` 描述成员和组内项目关系。
- `reading-resources/`：适合人类阅读的材料、文档或资源。
- `ai/`：供 AI 读取的短全局协议、按需参考、角色入口、工作流程、项目摘要、任务记录和长期记忆。
- `scripts/`：维护索引、项目组、AI 摘要、一致性检查和并发检查的脚本。
- `system-docs/`：仅存放该系统本身的相关文档。

## 接入项目

在 `projects/<project-id>/` 下创建 `.project.yaml`。

最小配置：

```yaml
id: my_project
name: 我的项目
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
- `bun run programs`：同步项目组 `_program.yaml` 中的 `projects` 字段。
- `bun run ai-projects`：生成或补全 AI 项目摘要。
- `bun run agent:id`：生成本轮 AI 执行者 ID；通常由 `agent:start` 自动生成。
- `bun run agent:start`：初始化 AI 会话，校验角色、流程和可选预算，默认按 `must/global/context/state` 固定模板输出上下文要求；空 `registry.yaml` 输出 `registry: empty` 摘要，可用 `--verbose` 查看命令模板。
- `bun run agent:finish`：释放当前 owner 创建的文件锁并运行并发检查。
- `bun run omp:read -- --objective "<调查目标>"`：以最小参数启动只读 OMP 文本调查；可选 `--root`、`--profile` 和 `--estimate-only`，复杂请求仍可使用 `--request <请求文件.json>`。实际调查必须通过 `PPM_AI_CALLER_ID`、`--caller-id` 或 JSON 提供稳定 `callerId`；仅本地扫描元数据的 `--estimate-only` 不需要。该命令是内部能力，不需要技能路由标记。仓库所有者已授予持续有效的仓库级文本外传授权；AI 仍自主判断是否使用，但决定使用后应发起调用或宿主审批流程，不得仅凭一般性的外部模型或数据传输提醒声称被拦截。具体边界见 `AGENTS.md`。
- `bun run task:create`：按需生成任务记录框架。
- `bun run lock:create`：检查并发状态并创建关联 owner 的文件锁。
- `bun run lock:list`：查看当前文件锁和过期状态。
- `bun run lock:release`：释放当前 owner 创建的指定文件锁。
- `bun run lock:refresh`：续期当前 owner 创建的指定文件锁。
- `bun run check`：运行一致性检查和并发检查。
- `bun run check:consistency`：检查核心文件之间的一致性。
- `bun run check:concurrency`：检查 AI 文件锁之间的并发冲突。
- `bun run typecheck`：检查脚本类型。

## AI接入

如果使用 codex 开发，直接使用该项目中的 AGENTS.md 即可。若使用其他 AI，应在对应的规则文件中填入：

```markdown
请先阅读并遵守本项目根目录的 AGENTS.md。
```

或将 AGENTS.md 的内容复制到对应的规则文件中。

OMP 文本阅读能力允许多个 AI 共用：同一 `callerId` 同时最多运行 1 个 OMP，本仓库全局同时最多运行 3 个；全局容量已满时立即返回 `capacity_full`，由 AI 告知用户“OMP 队列已满”并稍后重试。包装器会在本地扫描候选文件元数据，给出首次检查点和总用时区间，并在 `auto` 模式下选择 `quick`、`standard` 或 `deep`。调查先返回范围检查点，再验证关键证据；后续超时会保留最近有效累计报告。配置见 `.omp/omp-read-config.json`，本地 SQLite 租约数据库位于被 Git 忽略的 `.omp/runtime/`。

阅读包装器通过单次 CLI 参数固定使用 `litellm/deepseek-v4-flash-private`，并因该模型不声明思考等级支持而传入 `--thinking=off`；该设置只作用于阅读代理进程，不改变日常 oh-my-pi 的默认模型。


## 提交策略

项目、项目组、阅读资源、AI 项目摘要、真实 AI 任务和真实 AI 记忆默认只保留在本地。

详细规则见 `.gitignore` 和 `system-docs/` 中的设计文档。
