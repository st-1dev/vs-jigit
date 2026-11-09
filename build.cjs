const { execFileSync } = require("node:child_process");
const { build } = require("esbuild");
for (const project of [".", "web"]) {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", project], {
    stdio: "inherit",
  });
}
async function main() {
  await build({
    entryPoints: ["web/main.ts"],
    bundle: true,
    outfile: "dist/web/app.js",
    format: "iife",
    target: "es2022",
    minify: true,
    loader: { ".ttf": "file" },
    assetNames: "[name]-[hash]",
  });
  await build({
    entryPoints: ["node_modules/monaco-editor/esm/vs/editor/editor.worker.js"],
    bundle: true,
    outfile: "dist/web/editor.worker.js",
    format: "iife",
    target: "es2022",
    minify: true,
  });
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
