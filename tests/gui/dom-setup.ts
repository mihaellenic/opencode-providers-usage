import { transformAsync } from "@babel/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";

// DOM globals exist only in the GUI test runner: this file is the GUI
// bunfig preload and is never loaded by the root `bun test`.
GlobalRegistrator.register();

const GUI_FILE =
	/[\\/]src[\\/]gui\.tsx$|[\\/](?:src|tests)[\\/]gui[\\/].*\.tsx$/;
const here = import.meta.dir;
const presetSolid = Bun.resolveSync("babel-preset-solid", here);
const presetTypescript = Bun.resolveSync("@babel/preset-typescript", here);

// Solid's DOM compiler for browser files only. Everything else keeps Bun's own
// transform, so the OpenTUI JSX transform of the root TSX is never touched.
plugin({
	name: "solid-dom-transform",
	setup(build) {
		build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
			if (!GUI_FILE.test(path)) return undefined;
			const code = await Bun.file(path).text();
			const out = await transformAsync(code, {
				filename: path,
				babelrc: false,
				configFile: false,
				presets: [
					[presetSolid, { generate: "dom", hydratable: false }],
					[presetTypescript, { onlyRemoveTypeImports: true }],
				],
				sourceMaps: false,
			});
			if (out?.code == null) throw new Error(`Solid DOM transform: ${path}`);
			return { contents: out.code, loader: "js" };
		});
	},
});
