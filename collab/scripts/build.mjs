// Bundles the service into dist/server.js.
//   - the workspace package @hostidian/editor-schema (TypeScript source) is bundled inline,
//   - every npm dependency stays external and is resolved from node_modules at runtime
//     (`pnpm deploy --prod` ships exactly those).
import { readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const runtimeDeps = Object.keys(pkg.dependencies ?? {});

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  jsx: "automatic",
  sourcemap: true,
  legalComments: "none",
  external: runtimeDeps.flatMap((dep) => [dep, `${dep}/*`]),
  logLevel: "info",
});
