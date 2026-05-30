import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECT_OWNERSHIPS,
  PROJECT_RELATION_TYPES,
  PROJECT_STATUSES,
  REGISTRY_FIELDS,
  REQUIRED_FIELDS,
  buildRegistry,
  dumpYaml,
  isPlainObject,
  readYaml
} from "./_shared.ts";

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

function sameYaml(a, b) {
  return dumpYaml(a).trim() === dumpYaml(b).trim();
}

function isSnakeCase(value) {
  return /^[a-z][a-z0-9_]*$/.test(value);
}

function readProjectFacts() {
  const projectsDir = path.join(root, "projects");
  const projects = [];

  if (!fs.existsSync(projectsDir)) return projects;

  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const filePath = path.join(projectsDir, entry.name, ".project.yaml");
    if (!fs.existsSync(filePath)) {
      error(`missing .project.yaml: projects/${entry.name}/.project.yaml`);
      continue;
    }

    let project;
    try {
      project = readYaml(filePath);
    } catch (parseError) {
      error(`invalid yaml: ${path.relative(root, filePath)}: ${parseError.message}`);
      continue;
    }

    for (const field of REQUIRED_FIELDS) {
      if (project[field] === undefined || project[field] === null) {
        error(`${path.relative(root, filePath)} missing required field: ${field}`);
      }
    }

    for (const field of Object.keys(project)) {
      if (!isSnakeCase(field)) {
        error(`${path.relative(root, filePath)} field is not snake_case: ${field}`);
      }
    }

    if (!PROJECT_STATUSES.includes(project.status)) {
      error(`${project.id || entry.name} invalid status: ${project.status}`);
    }

    if (!PROJECT_OWNERSHIPS.includes(project.ownership)) {
      error(`${project.id || entry.name} invalid ownership: ${project.ownership}`);
    }

    if (Array.isArray(project.relations)) {
      for (const relation of project.relations) {
        if (!PROJECT_RELATION_TYPES.includes(relation.type)) {
          error(`${project.id || entry.name} invalid relation type: ${relation.type}`);
        }
      }
    }

    projects.push(project);
  }

  const ids = new Set(projects.map((project) => project.id));
  const names = new Map();
  for (const project of projects) {
    const items = names.get(project.name) || [];
    items.push(project);
    names.set(project.name, items);
  }

  for (const project of projects) {
    if (!Array.isArray(project.relations)) continue;

    for (const relation of project.relations) {
      if (ids.has(relation.target)) continue;
      const byName = names.get(relation.target) || [];
      if (byName.length === 0) {
        error(`${project.id} relation target not found: ${relation.target}`);
      } else if (byName.length > 1) {
        warning(`${project.id} relation target matches multiple names: ${relation.target}`);
      }
    }
  }

  return projects;
}

function checkRegistry() {
  const registryPath = path.join(root, "registry.yaml");
  if (!fs.existsSync(registryPath)) {
    error("missing registry.yaml");
    return null;
  }

  let actual;
  try {
    actual = readYaml(registryPath);
  } catch (parseError) {
    error(`invalid registry.yaml: ${parseError.message}`);
    return null;
  }

  const { registry: expected, warnings: relationWarnings } = buildRegistry(root);
  for (const item of relationWarnings) warning(item);

  if (!sameYaml(actual, expected)) {
    error("registry.yaml is not consistent with projects/*/.project.yaml");
  }

  for (const [id, project] of Object.entries(actual.projects || {})) {
    for (const field of Object.keys(project)) {
      if (!REGISTRY_FIELDS.includes(field)) {
        error(`registry project ${id} contains custom field: ${field}`);
      }
    }
  }

  return actual;
}

function checkPrograms(registry) {
  const programsDir = path.join(root, "programs");
  if (!registry || !fs.existsSync(programsDir)) return;

  for (const entry of fs.readdirSync(programsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const filePath = path.join(programsDir, entry.name, "_program.yaml");
    if (!fs.existsSync(filePath)) continue;

    const program = readYaml(filePath);
    const members = Array.isArray(program.members) ? program.members : [];
    const memberSet = new Set(members);

    for (const id of members) {
      if (!registry.projects || !registry.projects[id]) {
        error(`${path.relative(root, filePath)} member not found in registry: ${id}`);
      }
    }

    const expectedProjects = members
      .filter((id) => registry.projects && registry.projects[id])
      .map((id) => {
        const project = registry.projects[id];
        const relations = Array.isArray(project.relations)
          ? project.relations.filter((relation) => memberSet.has(relation.target))
          : null;

        return {
          id: project.id,
          name: project.name,
          status: project.status,
          ownership: project.ownership,
          relations: relations && relations.length > 0 ? relations : null
        };
      });

    const actualProjects = Array.isArray(program.projects) ? program.projects : null;
    if (!sameYaml(actualProjects, expectedProjects)) {
      error(`${path.relative(root, filePath)} projects is not synced`);
    }

    if (Array.isArray(program.projects)) {
      for (const project of program.projects) {
        for (const field of Object.keys(project)) {
          if (!["id", "name", "status", "ownership", "relations"].includes(field)) {
            error(`${path.relative(root, filePath)} project ${project.id} contains invalid field: ${field}`);
          }
        }

        if (Array.isArray(project.relations)) {
          for (const relation of project.relations) {
            if (!memberSet.has(relation.target)) {
              error(`${path.relative(root, filePath)} project ${project.id} contains external relation: ${relation.target}`);
            }
          }
        }
      }
    }
  }
}

function readFactLine(text, label) {
  const match = text.match(new RegExp(`^- ${label}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

function checkAiSummaries(projects) {
  const byId = new Map(projects.map((project) => [project.id, project])) as Map<string, any>;
  const aiProjectsDir = path.join(root, "ai", "projects");
  if (!fs.existsSync(aiProjectsDir)) return;

  for (const entry of fs.readdirSync(aiProjectsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const id = entry.name.slice(0, -3);
    const project = byId.get(id);
    const filePath = path.join(aiProjectsDir, entry.name);
    const text = fs.readFileSync(filePath, "utf8");

    if (!project) {
      warning(`${path.relative(root, filePath)} has no matching project`);
      continue;
    }

    for (const section of ["## 元信息", "## 事实"]) {
      if (!text.includes(section)) {
        warning(`${path.relative(root, filePath)} missing section: ${section}`);
      }
    }

    const checks = [
      ["ID", project.id],
      ["名称", project.name],
      ["项目状态", project.status],
      ["归属", project.ownership]
    ];

    for (const [label, expected] of checks) {
      const actual = readFactLine(text, label);
      if (actual && actual !== String(expected)) {
        warning(`${path.relative(root, filePath)} fact mismatch ${label}: ${actual} != ${expected}`);
      }
    }

    if (text.includes("- 摘要状态：confirmed")) {
      for (const [label, expected] of checks) {
        const actual = readFactLine(text, label);
        if (actual && actual !== String(expected)) {
          warning(`${path.relative(root, filePath)} is confirmed but may be stale`);
          break;
        }
      }
    }
  }
}

function checkExamples() {
  const required = [
    "projects/example_project/.project.yaml",
    "projects/example_project/index.ts",
    "registry.example.yaml",
    "programs/example_program/_program.yaml",
    "ai/tasks/example_task.md",
    "ai/memory/global.example.md",
    "ai/memory/projects/example_project.md",
    "human/projects/example_project/示例项目文档.md",
    "human/未分类/示例文档.md"
  ];

  for (const item of required) {
    if (!fs.existsSync(path.join(root, item))) {
      error(`missing example file: ${item}`);
    }
  }

  const examplePath = path.join(root, "registry.example.yaml");
  if (fs.existsSync(examplePath)) {
    const example = readYaml(examplePath);
    const ids = Object.keys(example.projects || {});
    if (ids.length !== 1 || ids[0] !== "example_project") {
      error("registry.example.yaml must contain only example_project");
    }
  }
}

const projects = readProjectFacts();
const registry = checkRegistry();
checkPrograms(registry);
checkAiSummaries(projects);
checkExamples();

for (const item of warnings) {
  console.warn(`warning: ${item}`);
}

for (const item of errors) {
  console.error(`error: ${item}`);
}

if (errors.length > 0) {
  process.exit(1);
}

console.log("consistency check passed");
