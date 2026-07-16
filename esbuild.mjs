import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

function copyTablerWebfont() {
  const srcRoot = join(
    __dirname,
    "node_modules",
    "@tabler",
    "icons-webfont",
    "dist",
  );
  const destRoot = join(__dirname, "media", "tabler");
  if (!existsSync(srcRoot)) {
    console.warn(
      "[esbuild] @tabler/icons-webfont not found — run yarn install",
    );
    return;
  }
  mkdirSync(join(destRoot, "fonts"), { recursive: true });
  cpSync(
    join(srcRoot, "tabler-icons.min.css"),
    join(destRoot, "tabler-icons.min.css"),
  );
  // Only the default outline font set used by tabler-icons.min.css
  for (const name of [
    "tabler-icons.woff2",
    "tabler-icons.woff",
    "tabler-icons.ttf",
  ]) {
    const from = join(srcRoot, "fonts", name);
    if (existsSync(from)) {
      cpSync(from, join(destRoot, "fonts", name));
    }
  }
  console.log("[esbuild] copied Tabler icons webfont → media/tabler/");
}

copyTablerWebfont();

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  sourcesContent: false,
  minify: false,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[esbuild] watching…");
} else {
  await esbuild.build(options);
}
