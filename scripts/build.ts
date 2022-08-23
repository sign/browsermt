import path from "path";
import { build as esbuild } from "esbuild";

const baseConfig = {
  platform: "node" as const,
  target: "esnext" as const,
  format: "cjs" as const,
  nodePaths: [path.join(__dirname, "../src")],
  sourcemap: true,
  external: [],
};

async function main() {
  const entryPoints = [
    path.join(__dirname, "../src/index.ts"),
    path.join(__dirname, "../src/main.ts"),
    path.join(__dirname, "../src/worker.ts"),
  ];
  await esbuild({
    ...baseConfig,
    outdir: path.join(__dirname, "../build/cjs"),
    entryPoints,
  });

  await esbuild({
    ...baseConfig,
    format: "esm",
    outdir: path.join(__dirname, "../build/esm"),
    entryPoints,
  });

  await esbuild({
    ...baseConfig,
    format: "esm",
    bundle: true,
    outdir: path.join(__dirname, "../build/bundled"),
    entryPoints,
  });
}

if (require.main === module) {
  main();
}
