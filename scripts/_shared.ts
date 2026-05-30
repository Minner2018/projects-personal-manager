import fs from "node:fs";
import path from "node:path";

const REQUIRED_FIELDS = ["id", "name", "status", "ownership"];
const RECOMMENDED_FIELDS = ["description", "tech_stack", "main_entries", "commands", "relations"];
const REGISTRY_FIELDS = [...REQUIRED_FIELDS, ...RECOMMENDED_FIELDS];
const PROJECT_STATUSES = ["idea", "active", "paused", "maintenance", "archived"];
const PROJECT_OWNERSHIPS = ["owned", "forked", "external", "reference"];
const PROJECT_RELATION_TYPES = ["depends_on", "used_by", "related_to", "part_of", "replaces"];

function isPlainObject(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseScalar(raw: string): any {
  const value = raw.trim();

  if (value === "" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseYaml(text: string): any {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  const root: any = {};
  const stack = [{ indent: -1, value: root }];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;

    if (trimmed.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`列表项没有列表父级: ${line}`);
      }

      const itemText = trimmed.slice(2).trim();
      if (itemText.includes(": ")) {
        const [key, ...rest] = itemText.split(":");
        const item = {};
        item[key.trim()] = parseScalar(rest.join(":").trim());
        parent.push(item);
        stack.push({ indent, value: item });
      } else {
        parent.push(parseScalar(itemText));
      }
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(`无法解析 YAML 行: ${line}`);
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();

    if (rawValue !== "") {
      parent[key] = parseScalar(rawValue);
      continue;
    }

    const nextLine = lines[index + 1];
    const nextTrimmed = nextLine ? nextLine.trim() : "";
    const nextValue = nextTrimmed.startsWith("- ") ? [] : {};
    parent[key] = nextValue;
    stack.push({ indent, value: nextValue });
  }

  return root;
}

function quoteString(value: string) {
  if (value === "" || value === "null" || value === "true" || value === "false") {
    return JSON.stringify(value);
  }
  if (/[:#\[\]{},&*!|>'"%@`]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function formatScalar(value: any) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return quoteString(value);
  return String(value);
}

function dumpYaml(value: any, indent = 0): string {
  const spaces = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]\n";
    return value
      .map((item) => {
        if (isPlainObject(item)) {
          const entries = Object.entries(item);
          if (entries.length === 0) return `${spaces}- {}\n`;
          const [firstKey, firstValue] = entries[0];
          let output = "";
          if (isPlainObject(firstValue) || Array.isArray(firstValue)) {
            output += `${spaces}- ${firstKey}:\n${dumpYaml(firstValue, indent + 4)}`;
          } else {
            output += `${spaces}- ${firstKey}: ${formatScalar(firstValue)}\n`;
          }
          for (const [key, child] of entries.slice(1)) {
            if (isPlainObject(child) || Array.isArray(child)) {
              output += `${" ".repeat(indent + 2)}${key}:\n${dumpYaml(child, indent + 4)}`;
            } else {
              output += `${" ".repeat(indent + 2)}${key}: ${formatScalar(child)}\n`;
            }
          }
          return output;
        }
        return `${spaces}- ${formatScalar(item)}\n`;
      })
      .join("");
  }

  if (isPlainObject(value)) {
    return Object.entries(value)
      .map(([key, child]) => {
        if (isPlainObject(child) || Array.isArray(child)) {
          return `${spaces}${key}:\n${dumpYaml(child, indent + 2)}`;
        }
        return `${spaces}${key}: ${formatScalar(child)}\n`;
      })
      .join("");
  }

  return `${spaces}${formatScalar(value)}\n`;
}

function readYaml(filePath: string): any {
  return parseYaml(fs.readFileSync(filePath, "utf8"));
}

function writeFileWithBackup(filePath: string, content: string) {
  const backupPath = `${filePath}.bak`;
  const existed = fs.existsSync(filePath);

  if (existed) {
    fs.copyFileSync(filePath, backupPath);
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    if (existed && fs.existsSync(backupPath)) {
      fs.rmSync(backupPath);
    }
  } catch (error) {
    console.error(`写入失败: ${filePath}`);
    if (existed) {
      console.error(`已保留备份: ${backupPath}`);
    }
    throw error;
  }
}

function findProjectFiles(root: string, onlyIds: string[] | null = null) {
  const projectsDir = path.join(root, "projects");
  if (!fs.existsSync(projectsDir)) return [];

  return fs
    .readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !onlyIds || onlyIds.includes(entry.name))
    .map((entry) => path.join(projectsDir, entry.name, ".project.yaml"))
    .filter((filePath) => fs.existsSync(filePath));
}

function normalizeRelationTargets(projects: any[]) {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const byName = new Map();
  const warnings = [];

  for (const project of projects) {
    const items = byName.get(project.name) || [];
    items.push(project);
    byName.set(project.name, items);
  }

  for (const project of projects) {
    if (!Array.isArray(project.relations)) continue;

    project.relations = project.relations.map((relation) => {
      const next = { ...relation };
      const target = relation.target;

      if (byId.has(target)) {
        next.target = target;
        return next;
      }

      const nameMatches = byName.get(target) || [];
      if (nameMatches.length === 1) {
        next.target = nameMatches[0].id;
      } else if (nameMatches.length > 1) {
        warnings.push(`项目 ${project.id} 的关系 target "${target}" 匹配多个项目名称`);
      } else {
        warnings.push(`项目 ${project.id} 的关系 target "${target}" 无法匹配`);
      }
      return next;
    });
  }

  return warnings;
}

function buildRegistry(root: string, onlyIds: string[] | null = null): any {
  const projects = [];
  const warnings = [];

  for (const filePath of findProjectFiles(root, onlyIds)) {
    const raw = readYaml(filePath);
    const project = {};

    for (const field of REGISTRY_FIELDS) {
      project[field] = Object.prototype.hasOwnProperty.call(raw, field) ? raw[field] : null;
    }

    projects.push(project);
  }

  warnings.push(...normalizeRelationTargets(projects));

  const registry = { projects: {} };
  for (const project of projects.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    registry.projects[project.id] = project;
  }

  return { registry, warnings };
}

function loadRegistry(root: string): any {
  return readYaml(path.join(root, "registry.yaml"));
}

function appendMissingSections(filePath: string, sections: Array<{ heading: string; body?: string }>) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  let next = existing;

  for (const section of sections) {
    if (!next.includes(`\n${section.heading}\n`) && !next.startsWith(`${section.heading}\n`)) {
      next += `${next.endsWith("\n") || next === "" ? "" : "\n"}\n${section.heading}\n${section.body || ""}`;
    }
  }

  if (next !== existing) {
    writeFileWithBackup(filePath, next.trimEnd() + "\n");
  }
}

export {
  PROJECT_OWNERSHIPS,
  PROJECT_RELATION_TYPES,
  PROJECT_STATUSES,
  RECOMMENDED_FIELDS,
  REGISTRY_FIELDS,
  REQUIRED_FIELDS,
  appendMissingSections,
  buildRegistry,
  dumpYaml,
  isPlainObject,
  loadRegistry,
  normalizeRelationTargets,
  parseYaml,
  readYaml,
  writeFileWithBackup
};
