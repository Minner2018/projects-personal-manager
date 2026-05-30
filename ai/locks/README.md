# AI 文件锁

本目录用于多个 AI 从同一项目出发并行工作时声明文件级占用。

锁文件只表示“该文件当前由某个任务占用或需要确认”，不是事实源，不应覆盖 `projects/`、`programs/`、`registry.yaml` 或源码本身。

## 使用规则

1. AI 开始修改前，先检查 `ai/tasks/` 中状态为“进行中”的任务和本目录中的锁。
2. AI 应在任务文件中声明 `## 计划修改文件`。
3. 修改文件前，如需排他占用，应创建对应 `.lock` 文件。
4. 若目标文件已被其他任务声明或锁定，AI 不得静默修改，应报告冲突。
5. 任务完成、暂停或放弃相关修改时，应释放自己创建的锁。
6. 锁过期只代表需要人工确认，不代表其他 AI 可以自动覆盖。

并发状态检查使用 `workflows/系统-检查并发.md`，对应脚本为：

```powershell
bun run check:concurrency
```

该脚本会检查进行中任务声明的文件冲突、锁文件格式、锁引用的任务、锁定文件路径和过期时间。

创建锁文件时优先使用：

```powershell
bun run lock:create -- --file scripts/check-consistency.ts --task ai/tasks/2026-05-30-fix-check.md --owner ai-codex --reason 修复一致性检查逻辑
```

可选参数：

- `--hours`：锁过期小时数，默认 `2`。

脚本会生成仓库相对路径对应的 `.lock` 文件，拒绝绝对路径、缺失任务文件和已存在的同文件锁。

## 锁文件格式

文件名建议使用路径转义后的名称，例如 `scripts__check-consistency.ts.lock`。

```yaml
owner: ai-codex-1
task: ai/tasks/2026-05-30-fix-check.md
file: scripts/check-consistency.ts
created_at: 2026-05-30T20:30:00+08:00
expires_at: 2026-05-30T22:30:00+08:00
reason: 修复一致性检查逻辑
```

字段说明：

- `owner`：执行者标识。
- `task`：对应任务记录路径。
- `file`：被锁定的仓库相对路径，使用 `/`。
- `created_at`：锁创建时间。
- `expires_at`：预计失效时间。
- `reason`：占用原因。

`owner`、`task`、`file`、`created_at`、`expires_at` 和 `reason` 都是必填字段。
