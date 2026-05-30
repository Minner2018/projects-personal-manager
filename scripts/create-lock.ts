import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpYaml, readYaml, writeFileWithBackup } from "./_shared.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");

type Options = {
  file?: string;
  task?: string;
  owner?: string;
  reason?: string;
  hours: number;
};

function usage() {
  console.log(`usage: bun run lock:create -- --file <path> --task <path> --owner <id> --reason <text> [--hours 2]

required:
  --file    repository-relative path to lock
  --task    repository-relative task record path
  --owner   AI or operator identifier
  --reason  lock reason

optional:
  --hours   hours until expiration, default 2`);
}

function readOptions(args: string[]): Options {
  const options: Options = { hours: 2 };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    if (!arg.startsWith("--")) {
      throw new Error(`unknown argument: ${arg}`);
    }

    if (next === undefined || next.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }

    if (arg === "--file") options.file = next;
    else if (arg === "--task") options.task = next;
    else if (arg === "--owner") options.owner = next;
    else if (arg === "--reason") options.reason = next;
    else if (arg === "--hours") options.hours = Number(next);
    else throw new Error(`unknown option: ${arg}`);

    index += 1;
  }

  return options;
}

function normalizeRepoPath(value: string | undefined) {
  return String(value || "")
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function assertRepoRelative(label: string, value: string) {
  if (!value) throw new Error(`${label} is required`);
  if (path.isAbsolute(value)) throw new Error(`${label} must be repository-relative: ${value}`);
  if (value.split("/").includes("..")) throw new Error(`${label} must not contain '..': ${value}`);
}

function lockFileName(file: string) {
  return `${file.replace(/[\/\\]/g, "__")}.lock`;
}

function formatLocalDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`
  ].join("");
}

function findExistingLockForFile(file: string) {
  const locksDir = path.join(root, "ai", "locks");
  if (!fs.existsSync(locksDir)) return null;

  for (const entry of fs.readdirSync(locksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;

    const filePath = path.join(locksDir, entry.name);
    const lock = readYaml(filePath);
    if (normalizeRepoPath(lock.file) === file) {
      return path.relative(root, filePath).replace(/\\/g, "/");
    }
  }

  return null;
}

try {
  const options = readOptions(process.argv.slice(2));
  const file = normalizeRepoPath(options.file);
  const task = normalizeRepoPath(options.task);
  const owner = String(options.owner || "").trim();
  const reason = String(options.reason || "").trim();

  assertRepoRelative("file", file);
  assertRepoRelative("task", task);
  if (!owner) throw new Error("owner is required");
  if (!reason) throw new Error("reason is required");
  if (!Number.isFinite(options.hours) || options.hours <= 0) {
    throw new Error(`hours must be a positive number: ${options.hours}`);
  }

  const taskPath = path.join(root, task);
  if (!fs.existsSync(taskPath)) {
    throw new Error(`task file does not exist: ${task}`);
  }

  const existingLock = findExistingLockForFile(file);
  if (existingLock) {
    throw new Error(`lock already exists for ${file}: ${existingLock}`);
  }

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + options.hours * 60 * 60 * 1000);
  const lock = {
    owner,
    task,
    file,
    created_at: formatLocalDate(createdAt),
    expires_at: formatLocalDate(expiresAt),
    reason
  };
  const lockPath = path.join(root, "ai", "locks", lockFileName(file));

  writeFileWithBackup(lockPath, dumpYaml(lock));
  console.log(`created ${path.relative(root, lockPath).replace(/\\/g, "/")}`);
} catch (error) {
  console.error(`error: ${error.message}`);
  usage();
  process.exit(1);
}
