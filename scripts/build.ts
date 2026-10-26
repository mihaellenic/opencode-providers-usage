import { rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const root = fileURLToPath(new URL("..", import.meta.url));
const distDir = `${root}dist`;
const entrypoints = ["src/index.ts", "src/tui.tsx", "src/rpc.ts"].map(
	(path) => `${root}${path}`,
);
const expectedOutputs = ["index.js", "rpc.js", "tui.js"];

// Host-provided runtimes stay external so the single copy supplied by OpenCode
// is used. Solid is also external to avoid a second reactive runtime.
const external = ["@opencode/*", "@opentui/*", "solid-js", "solid-js/*"];

// Remove the previous output first so stale files can never ship.
rmSync(distDir, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints,
	outdir: distDir,
	target: "node",
	format: "esm",
	splitting: false,
	sourcemap: "none",
	external,
	plugins: [createSolidTransformPlugin()],
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

const produced = (await readdir(distDir)).sort();
if (JSON.stringify(produced) !== JSON.stringify(expectedOutputs)) {
	throw new Error(`unexpected dist contents: ${produced.join(", ")}`);
}

console.log(`built dist: ${produced.join(", ")}`);
