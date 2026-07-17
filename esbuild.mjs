import * as esbuild from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

/**
 * Ship only woff2 for the outline set (~450KB). Drop ttf/woff fallbacks
 * (~3.5MB) that modern webviews do not need.
 */
function copyTablerWebfont() {
  const srcRoot = join(
    __dirname,
    "node_modules",
    "@tabler",
    "icons-webfont",
    "dist",
  );
  const destRoot = join(__dirname, "media", "tabler");
  const destFonts = join(destRoot, "fonts");
  if (!existsSync(srcRoot)) {
    console.warn(
      "[esbuild] @tabler/icons-webfont not found — run yarn install",
    );
    return;
  }
  mkdirSync(destFonts, { recursive: true });

  const cssSrc = join(srcRoot, "tabler-icons.min.css");
  const cssDest = join(destRoot, "tabler-icons.min.css");
  let css = readFileSync(cssSrc, "utf8");
  // Keep a single woff2 source so missing .woff/.ttf are not requested.
  css = css.replace(
    /src:url\("\.\/fonts\/tabler-icons\.woff2[^"]*"\)\s*format\("woff2"\)(?:,url\("\.\/fonts\/tabler-icons\.[^"]*"\)\s*format\("[^"]+"\))*/g,
    'src:url("./fonts/tabler-icons.woff2") format("woff2")',
  );
  writeFileSync(cssDest, css);

  const woff2 = "tabler-icons.woff2";
  const from = join(srcRoot, "fonts", woff2);
  if (!existsSync(from)) {
    console.warn(`[esbuild] missing ${woff2}`);
    return;
  }
  cpSync(from, join(destFonts, woff2));

  // Remove leftover fallback fonts from older builds
  for (const name of ["tabler-icons.woff", "tabler-icons.ttf"]) {
    const stale = join(destFonts, name);
    if (existsSync(stale)) {
      rmSync(stale);
    }
  }

  console.log(
    "[esbuild] copied Tabler icons webfont (woff2 only) → media/tabler/",
  );
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
