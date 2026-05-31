import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readYaml } from "./_shared.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const errors = [];
const warnings = [];

function error(message) {
  errors.push(message);
}

function warning(message) {
  warnings.push(message);
}

function normalizeRepoPath(value) {
  return String(value || "")
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function isEmptyListItem(value) {
  return ["", "无", "无。", "none", "null", "n/a"].includes(String(value).trim().toLowerCase());
}

function readTaskStatus(text) {
  const match = text.match(/^- 任务状态[：:]\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function readMarkdownListSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let inSection = false;

  for (const line of lines) {
    if (line.trim() === heading) {
      inSection = true;
      continue;
    }

    if (inSection && line.startsWith("## ")) break;
    if (!inSection) continue;

    const match = line.match(/^\s*-\s+(.+)$/);
    if (!match) continue;

    const item = normalizeRepoPath(match[1]);
    if (!isEmptyListItem(item)) items.push(item);
  }

  return items;
}

function collectActiveTaskClaims() {
  const tasksDir = path.join(root, "ai", "tasks");
  const activeTasks = [];

  if (!fs.existsSync(tasksDir)) return new Map();

  for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const filePath = path.join(tasksDir, entry.name);
    const relPath = normalizeRepoPath(path.relative(root, filePath));
    const text = fs.readFileSync(filePath, "utf8");
    const status = readTaskStatus(text);
    if (status !== "进行中") continue;

    const files = [
      ...readMarkdownListSection(text, "## 计划修改文件"),
      ...readMarkdownListSection(text, "## 实际修改文件")
    ];

    activeTasks.push({
      path: relPath,
      files: [...new Set(files)]
    });
  }

  const claims = new Map();
  for (const task of activeTasks) {
    for (const file of task.files) {
      const items = claims.get(file) || [];
      items.push(task.path);
      claims.set(file, items);
    }
  }

  return claims;
}

function checkTaskClaimConflicts(claims) {
  for (const [file, tasks] of claims.entries()) {
    if (tasks.length > 1) {
      error(`concurrent AI task file conflict: ${file} claimed by ${tasks.join(", ")}`);
    }
  }
}

function checkLocks(claims) {
  const locksDir = path.join(root, "ai", "locks");
  if (!fs.existsSync(locksDir)) return;

  for (const entry of fs.readdirSync(locksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;

    const filePath = path.join(locksDir, entry.name);
    const relPath = normalizeRepoPath(path.relative(root, filePath));
    let lock;
    try {
      lock = readYaml(filePath);
    } catch (parseError) {
      error(`invalid lock yaml: ${relPath}: ${parseError.message}`);
      continue;
    }

    for (const field of ["owner", "file", "created_at", "expires_at", "reason"]) {
      if (!lock[field]) {
        error(`${relPath} missing required field: ${field}`);
      }
    }

    const lockedFile = normalizeRepoPath(lock.file);

    if (lockedFile && path.isAbsolute(lockedFile)) {
      error(`${relPath} file must be a repository-relative path: ${lock.file}`);
    }

    if (lock.expires_at) {
      const expiresAt = new Date(lock.expires_at);
      if (Number.isNaN(expiresAt.getTime())) {
        error(`${relPath} invalid expires_at: ${lock.expires_at}`);
      } else if (expiresAt.getTime() < Date.now()) {
        warning(`${relPath} is expired and needs human confirmation`);
      }
    }

    const claimingTasks = claims.get(lockedFile) || [];
    if (claimingTasks.length > 0) {
      error(`AI lock conflict: ${lockedFile} locked by ${lock.owner || relPath}, claimed by ${claimingTasks.join(", ")}`);
    }
  }
}

const claims = collectActiveTaskClaims();
checkTaskClaimConflicts(claims);
checkLocks(claims);

for (const item of warnings) {
  console.warn(`warning: ${item}`);
}

for (const item of errors) {
  console.error(`error: ${item}`);
}

if (errors.length > 0) {
  process.exit(1);
}

console.log("concurrency check passed");
