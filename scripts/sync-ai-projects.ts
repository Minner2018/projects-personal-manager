import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendMissingSections, buildRegistry, writeFileWithBackup } from "./_shared.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const aiProjectsDir = path.join(root, "ai", "projects");
const { registry } = buildRegistry(root);

function listValue(value) {
  if (value === null || value === undefined) return "无。";
  if (Array.isArray(value)) return value.map((item) => `- ${item}`).join("\n");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `- ${key}: ${item}`)
      .join("\n");
  }
  return String(value);
}

function createSummary(project) {
  return `# 项目 AI 摘要：${project.id}

## 元信息
- 摘要状态：draft
- 最后核验：YYYY-MM-DD
- 已检查来源：.project.yaml, registry.yaml

## 摘要

## 事实
- ID: ${project.id}
- 名称: ${project.name}
- 项目状态: ${project.status}
- 归属: ${project.ownership}
- 说明: ${project.description ?? ""}

## 技术栈

${listValue(project.tech_stack)}

## 入口

${listValue(project.main_entries)}

## 命令

${listValue(project.commands)}

## 关系

${listValue(project.relations)}

## 近期任务

## 关键说明

## AI 阅读指引

优先读取 \`projects/${project.id}/.project.yaml\`。

## 约束
`;
}

const sections = [
  { heading: "## 元信息", body: "- 摘要状态：draft\n- 最后核验：YYYY-MM-DD\n- 已检查来源：.project.yaml, registry.yaml\n" },
  { heading: "## 摘要", body: "" },
  { heading: "## 事实", body: "" },
  { heading: "## 技术栈", body: "" },
  { heading: "## 入口", body: "" },
  { heading: "## 命令", body: "" },
  { heading: "## 关系", body: "" },
  { heading: "## 近期任务", body: "" },
  { heading: "## 关键说明", body: "" },
  { heading: "## AI 阅读指引", body: "" },
  { heading: "## 约束", body: "" }
];

fs.mkdirSync(aiProjectsDir, { recursive: true });

const projects = Object.values(registry.projects || {}) as any[];

for (const project of projects) {
  const filePath = path.join(aiProjectsDir, `${project.id}.md`);

  if (!fs.existsSync(filePath)) {
    writeFileWithBackup(filePath, createSummary(project));
    console.log(`created ${path.relative(root, filePath)}`);
    continue;
  }

  appendMissingSections(filePath, sections);
  console.log(`checked ${path.relative(root, filePath)}`);
}
