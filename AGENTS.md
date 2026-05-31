# AGENTS.md

## 基础配置
- 语言：中文
- 系统: Windows11
- 常用编码：UTF-8
- 命令行环境：PowerShell

## 工作流程

在第3步前不要执行具体工作内容。

1. 先理解 `ai/global.md`。
2. AI 在首次开始对话时运行 `bun run agent:id` 获取本轮 `agent_id`，并加入上下文；该 ID 用作锁的 `owner`。
3. 按任务类型明确角色、工作流和上下文预算。
4. 按角色和工作流流程执行用户的任务。
5. 修改文件前按 `ai/workflows/并发协作.md` 检查锁。
6. 需要系统检查时优先运行对应脚本。
