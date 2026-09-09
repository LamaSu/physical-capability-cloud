// Ship the capability catalog next to the compiled entrypoint so
// `getCatalog()` (which reads catalog.json relative to import.meta.url)
// resolves it in dist/ the same way it does from src/ under vitest.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
copyFileSync(join(root, "src", "catalog.json"), join(root, "dist", "catalog.json"));
console.log("[adapter-galaxy-synbiocad] copied catalog.json -> dist/");
