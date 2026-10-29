import { gui } from "@opencode/plugin/gui/vite";
import { defineConfig } from "vite";

// GUI bundle only: one CommonJS file. The SDK preset keeps the host-provided
// modules (@opencode/plugin/gui, @opencode/plugin/rpc, solid-js, solid-js/web)
// external and bundles everything else. The Bun build owns the CLI outputs.
export default defineConfig({
	plugins: [
		gui({ entry: "src/gui.tsx", outFile: "dist/gui-experimental.cjs" }),
	],
	build: { emptyOutDir: false },
});
