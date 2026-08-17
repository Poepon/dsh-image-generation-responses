import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const required = [
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "RELEASING.md",
  ".github/workflows/ci.yml",
  ".github/dependabot.yml",
  "lib/index.js",
  "lib/protocol.js",
  "lib/client.js",
];

for (const path of required) {
  if (!existsSync(join(root, path))) throw new Error(`missing release file: ${path}`);
}
if (packageJson.license !== "MIT") throw new Error("package license must be MIT");
if (packageJson.repository?.url !== "git+https://github.com/Poepon/dsh-image-generation-responses.git") {
  throw new Error("unexpected repository URL");
}
if (!Array.isArray(packageJson.files) || packageJson.files.length !== 1 || packageJson.files[0] !== "lib") {
  throw new Error("npm files allowlist must contain only lib");
}

const ignored = new Set(["node_modules", ".git"]);
const forbidden = [/ai\.yaspost\.com/i, /GPT_API_KEY/, /Bearer\s+sk-[A-Za-z0-9_-]{12,}/];
function walk(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|json|md|ya?ml)$/.test(entry.name) || entry.name === "LICENSE") {
      const text = readFileSync(full, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(text)) throw new Error(`forbidden release content ${pattern} in ${full}`);
      }
    }
  }
}
walk(root);

const client = readFileSync(join(root, "lib/client.js"), "utf8");
if (!client.includes('id: "dsh-image-generation-responses"')) {
  throw new Error("client bundle module id does not match package name");
}

console.log(`release manifest OK (${packageJson.name}@${packageJson.version})`);
