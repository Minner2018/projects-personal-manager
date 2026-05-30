import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry, dumpYaml, writeFileWithBackup } from "./_shared.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const { registry, warnings } = buildRegistry(root);

for (const warning of warnings) {
  console.warn(`warning: ${warning}`);
}

writeFileWithBackup(path.join(root, "registry.yaml"), dumpYaml(registry));
console.log("generated registry.yaml");
