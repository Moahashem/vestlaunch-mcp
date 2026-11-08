/**
 * Fail CI if the HTTP server's authz module would be omitted from a Vercel
 * upload, or if the stdio entrypoint would be uploaded and compete as the
 * root. Patterns match the ones in .vercelignore: comments, negation,
 * a directory name, and a single-segment star.
 */
import { readFileSync } from "node:fs";

const rules = readFileSync(new URL("../.vercelignore", import.meta.url), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .map((line) => {
    const neg = line.startsWith("!");
    return { neg, pat: (neg ? line.slice(1) : line).replace(/\/+$/, "") };
  });

function matches(pat, file) {
  if (pat.endsWith("/*")) {
    const dir = pat.slice(0, -2);
    const rest = file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : "";
    return rest.length > 0 && !rest.includes("/");
  }
  return file === pat || file.startsWith(`${pat}/`);
}

function ignored(file) {
  let result = false;
  for (const rule of rules) {
    if (matches(rule.pat, file)) result = !rule.neg;
  }
  return result;
}

const expectIgnored = ["src/index.ts", "src/server.ts", "src/tools.ts", "dist/index.js", "tsconfig.json"];
const expectIncluded = ["src/mcp-authz.ts", "api/mcp.ts", "server.ts"];
const failures = [];
for (const file of expectIgnored) {
  if (!ignored(file)) failures.push(`${file} would be uploaded`);
}
for (const file of expectIncluded) {
  if (ignored(file)) failures.push(`${file} would be omitted`);
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("vercel include check ok");
