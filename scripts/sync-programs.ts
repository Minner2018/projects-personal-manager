import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpYaml, loadRegistry, readYaml, writeFileWithBackup } from "./_shared.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const programsDir = path.join(root, "programs");
const registry = loadRegistry(root);

if (!fs.existsSync(programsDir)) {
  console.log("no programs directory");
  process.exit(0);
}

for (const entry of fs.readdirSync(programsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const filePath = path.join(programsDir, entry.name, "_program.yaml");
  if (!fs.existsSync(filePath)) continue;

  const program = readYaml(filePath);
  const members = Array.isArray(program.members) ? program.members : [];
  const memberSet = new Set(members);

  const projects = members.map((id) => {
    const project = registry.projects && registry.projects[id];
    if (!project) {
      throw new Error(`program ${program.id || entry.name} member not found in registry: ${id}`);
    }

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

  const nextProgram = { ...program, projects };
  writeFileWithBackup(filePath, dumpYaml(nextProgram));
  console.log(`synced ${path.relative(root, filePath)}`);
}
