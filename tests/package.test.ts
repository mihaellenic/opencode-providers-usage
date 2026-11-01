import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	bannedArtifactContent,
	validateBundleImports,
} from "../scripts/release-acceptance";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const manifest = JSON.parse(read("package.json"));
const dist = (path: string): string => join(root, "dist", path);

const GUI_BUNDLE = "gui-experimental.cjs";
const CLI_DIST_FILES = ["index.js", "rpc.js", "tui.js"];
const EXPECTED_DIST_FILES = [GUI_BUNDLE, ...CLI_DIST_FILES];
const GUI_HOST_MODULES = new Set([
	"@opencode/plugin/gui",
	"@opencode/plugin/rpc",
	"solid-js",
	"solid-js/web",
]);
const EXPECTED_EXPORTS = {
	".": "./dist/index.js",
	"./server": "./dist/index.js",
	"./tui": "./dist/tui.js",
	"./rpc": "./dist/rpc.js",
	"./gui-experimental": "./dist/gui-experimental.cjs",
};
const ROOT_SHIMS = {
	"index.js": 'export { default } from "./dist/index.js"',
	"tui.js": 'export { default } from "./dist/tui.js"',
	"rpc.js": 'export * from "./dist/rpc.js"',
};
const EXPECTED_TARBALL = [
	"LICENSE",
	"README.md",
	"dist/gui-experimental.cjs",
	"dist/index.js",
	"dist/rpc.js",
	"dist/tui.js",
	"index.js",
	"package.json",
	"rpc.js",
	"tui.js",
];

const runBuild = (): { status: number | null; output: string } => {
	const result = spawnSync("bun", ["run", "build"], {
		cwd: root,
		encoding: "utf8",
	});
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const hostPackages = new Set([
	...Object.keys(manifest.dependencies ?? {}),
	...Object.keys(manifest.peerDependencies ?? {}),
]);

const packageNameOf = (specifier: string): string => {
	const parts = specifier.split("/");
	return specifier.startsWith("@")
		? parts.slice(0, 2).join("/")
		: (parts[0] ?? specifier);
};

const importedSpecifiers = (code: string): string[] =>
	[
		...code.matchAll(
			/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g,
		),
	].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

describe("package manifest", () => {
	test("is an ESM package at the bootstrap candidate version", () => {
		expect(manifest.name).toBe("opencode-providers-usage");
		expect(manifest.type).toBe("module");
		expect(manifest.version).toBe("0.1.0");
	});

	test("points main and every export at built dist files", () => {
		expect(manifest.main).toBe("./dist/index.js");
		expect(manifest.exports).toEqual(EXPECTED_EXPORTS);
	});

	test("uses only string export targets, without conditional or type exports", () => {
		for (const target of Object.values(manifest.exports)) {
			expect(typeof target).toBe("string");
		}
	});

	test("publishes only built output", () => {
		expect(manifest.files).toEqual(["dist/", "index.js", "tui.js", "rpc.js"]);
	});

	test("ships root JS shims that re-export the dist modules", () => {
		for (const [shim, source] of Object.entries(ROOT_SHIMS)) {
			expect(read(shim).trim()).toBe(source);
		}
	});

	test("publishes publicly with a prepack rebuild and no consumer install hooks", () => {
		expect(manifest.publishConfig).toEqual({ access: "public" });
		expect(manifest.scripts.prepack).toBe("bun run build");
		for (const hook of ["preinstall", "install", "postinstall"]) {
			expect(manifest.scripts[hook]).toBeUndefined();
		}
	});

	test("carries the owner-approved MIT publication metadata", () => {
		expect(manifest.license).toBe("MIT");
		expect(manifest.author).toBe("Mihael Lenic");
		expect(manifest.repository).toEqual({
			type: "git",
			url: "git+https://github.com/mihaellenic/opencode-providers-usage.git",
		});
		const license = read("LICENSE");
		expect(license).toContain("MIT License");
		expect(license).toContain("Copyright (c) 2026 Mihael Lenic");
	});

	test("declares the host runtime contract without changing peers", () => {
		expect(manifest.dependencies["@opencode/plugin"]).toBe("2.2.0");
		expect(manifest.peerDependencies).toEqual({
			"@opencode/theme": "2.2.0",
			"@opentui/core": ">=0.6.8",
			"@opentui/solid": ">=0.6.8",
			"solid-js": ">=1.9.0",
		});
	});
});

describe("built artifacts", () => {
	let build: { status: number | null; output: string };

	beforeAll(() => {
		build = runBuild();
	});

	test("bun run build succeeds", () => {
		expect(build.status).toBe(0);
	});

	test("dist contains exactly the CLI entry files and the GUI bundle", () => {
		expect(readdirSync(join(root, "dist")).sort()).toEqual(EXPECTED_DIST_FILES);
	});

	test("release acceptance validates every actual bundle, not only synthetic fixtures", () => {
		for (const file of EXPECTED_DIST_FILES) {
			const code = readFileSync(dist(file), "utf8");
			expect(() =>
				validateBundleImports(`dist/${file}`, code, hostPackages),
			).not.toThrow();
			expect(bannedArtifactContent(code, root)).toBe(false);
		}
	});

	test("each root JS shim loads and re-exports its dist module", async () => {
		const indexShim = await import(join(root, "index.js"));
		const indexDist = await import(dist("index.js"));
		expect(indexShim.default).toBe(indexDist.default);
		expect(indexShim.default).toBeDefined();

		const tuiShim = await import(join(root, "tui.js"));
		const tuiDist = await import(dist("tui.js"));
		expect(tuiShim.default).toBe(tuiDist.default);

		const rpcShim = await import(join(root, "rpc.js"));
		const rpcDist = await import(dist("rpc.js"));
		expect(Object.keys(rpcShim).sort()).toEqual(Object.keys(rpcDist).sort());
		for (const key of Object.keys(rpcDist)) {
			expect(rpcShim[key]).toBe(rpcDist[key]);
		}
	});

	test("checkout local discovery keeps TypeScript shims ahead of root JS shims", () => {
		const resolve = (specifier: string): string =>
			Bun.resolveSync(specifier, root);
		expect(resolve("./index")).toBe(join(root, "index.ts"));
		expect(resolve("./tui")).toBe(join(root, "tui.tsx"));
		expect(resolve("./rpc")).toBe(join(root, "rpc.ts"));
		expect(resolve("./index.js")).toBe(join(root, "index.js"));
	});

	test("package directory resolves to the built server entry", () => {
		expect(Bun.resolveSync(".", root)).toBe(dist("index.js"));
	});

	test("every export target exists after build", () => {
		for (const target of Object.values(EXPECTED_EXPORTS)) {
			expect(existsSync(join(root, target))).toBe(true);
		}
	});

	test("bundles import only node builtins, declared host packages, or externals", () => {
		for (const file of CLI_DIST_FILES) {
			const specifiers = importedSpecifiers(readFileSync(dist(file), "utf8"));
			for (const specifier of specifiers) {
				expect(specifier.startsWith(".") || specifier.startsWith("/")).toBe(
					false,
				);
				if (specifier.startsWith("node:")) continue;
				expect(hostPackages.has(packageNameOf(specifier))).toBe(true);
			}
		}
	});

	test("never imports checkout-only source or root shims", () => {
		for (const file of CLI_DIST_FILES) {
			const code = readFileSync(dist(file), "utf8");
			expect(code).not.toMatch(/["'](?:\.\.?\/)?src\//);
			expect(code).not.toMatch(/\.tsx?["']/);
		}
	});

	test("keeps host runtimes external in the TUI bundle", () => {
		const tui = readFileSync(dist("tui.js"), "utf8");
		const specifiers = importedSpecifiers(tui);
		expect(specifiers).toContain("solid-js");
		expect(specifiers).toContain("@opencode/plugin/tui");
		expect(
			specifiers.some((specifier) => specifier.startsWith("@opentui/")),
		).toBe(true);
	});

	test("does not bundle a second Solid or OpenTUI runtime", () => {
		for (const file of CLI_DIST_FILES) {
			const code = readFileSync(dist(file), "utf8");
			expect(code).not.toMatch(/function createSignal\b/);
			expect(code).not.toMatch(/function createRoot\b/);
			expect(code).not.toMatch(/function createComputed\b/);
		}
	});

	test("ships transformed JSX with no raw JSX or untransformed React calls", () => {
		const tui = readFileSync(dist("tui.js"), "utf8");
		expect(tui).not.toMatch(
			/React\.createElement|React\.jsx\b|\bcreateElement\(/,
		);
		expect(tui).not.toMatch(/<[A-Z][A-Za-z0-9]*[\s/>]/);
	});

	test("CLI bundles contain no GUI SDK or browser Solid import", () => {
		for (const file of CLI_DIST_FILES) {
			const code = readFileSync(dist(file), "utf8");
			for (const specifier of importedSpecifiers(code)) {
				expect(specifier).not.toMatch(/^@opencode\/plugin\/gui/);
				expect(specifier).not.toBe("solid-js/web");
			}
			expect(code).not.toContain("@opencode/plugin/gui");
			expect(code).not.toContain("solid-js/web");
		}
	});

	test("GUI bundle is CommonJS requiring only host modules and Node/Electron externals", () => {
		const code = readFileSync(dist(GUI_BUNDLE), "utf8");
		expect(code).toContain("exports");
		expect(code).not.toMatch(/^\s*(?:import|export)\s/m);
		const required = [
			...code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
		].map((match) => match[1] ?? "");
		expect(required).toContain("@opencode/plugin/gui");
		for (const specifier of required) {
			const allowed =
				GUI_HOST_MODULES.has(specifier) ||
				specifier.startsWith("node:") ||
				specifier === "electron";
			expect(allowed).toBe(true);
		}
	});

	test("building twice leaves exactly the expected files", () => {
		expect(runBuild().status).toBe(0);
		expect(runBuild().status).toBe(0);
		expect(readdirSync(join(root, "dist")).sort()).toEqual(EXPECTED_DIST_FILES);
	});

	test("removes stale dist files on rebuild", () => {
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(dist("stale.js"), "export {}\n");
		expect(runBuild().status).toBe(0);
		expect(existsSync(dist("stale.js"))).toBe(false);
		expect(readdirSync(join(root, "dist")).sort()).toEqual(EXPECTED_DIST_FILES);
	});
});

describe("README distribution contract", () => {
	const readme = read("README.md");

	/** Text of one section, heading excluded, up to the next heading of the same or higher level. */
	const section = (heading: string): string => {
		const start = readme.indexOf(`\n${heading}\n`);
		if (start === -1) throw new Error(`missing README section: ${heading}`);
		const level = heading.match(/^#+/)?.[0].length ?? 1;
		const rest = readme.slice(start + heading.length + 2);
		const next = rest.search(new RegExp(`\\n#{1,${level}} `));
		return next === -1 ? rest : rest.slice(0, next);
	};

	test("makes no not-published-to-a-registry claim", () => {
		expect(readme).not.toMatch(/not (?:yet )?published/i);
		expect(readme).not.toMatch(/registry/i);
	});

	test("documents the export table with targets identical to manifest.exports", () => {
		const rows = new Map<string, string>();
		for (const line of readme.split("\n")) {
			const match = line.match(/^\| `(\.[^`]*)` \| `([^`]+)` \|/);
			if (match) rows.set(match[1] ?? "", match[2] ?? "");
		}
		expect(Object.fromEntries(rows)).toEqual(manifest.exports);
		expect(rows.size).toBe(Object.keys(manifest.exports).length);
	});

	test("lists the experimental GUI export row", () => {
		expect(readme).toContain(
			"| `./gui-experimental` | `./dist/gui-experimental.cjs` |",
		);
	});

	test("provides the published npm install path and a separate source-checkout path", () => {
		const install = section("## Installation");
		expect(install).toMatch(/npm install opencode-providers-usage(?:\s|$)/m);
		expect(install).toContain(
			"### Install from a source checkout (development)",
		);
		const checkout = section(
			"### Install from a source checkout (development)",
		);
		expect(checkout).toContain("npx bun@1.4.4 run build");
		expect(checkout.indexOf("npx bun@1.4.4 run build")).toBeGreaterThan(-1);
	});

	test("keeps local TypeScript root-file guidance for checkouts", () => {
		expect(readme).toContain("root-file convention");
		expect(readme).toMatch(/`index\.ts`/);
		expect(readme).toMatch(/`tui\.tsx`/);
		expect(readme).toMatch(/`rpc\.ts`/);
		expect(readme).toMatch(/named installs[^.]*`exports`/i);
	});
});

describe("npm tarball", () => {
	let tarballPaths: string[] = [];

	beforeAll(() => {
		const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: root,
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		const output = result.stdout;
		const start = output.lastIndexOf("\n[");
		const parsed = JSON.parse(start >= 0 ? output.slice(start + 1) : output);
		tarballPaths = parsed[0].files
			.map((file: { path: string }) => file.path)
			.sort();
	}, 60_000);

	test("contains exactly the approved runtime files and package metadata", () => {
		expect(tarballPaths).toEqual(EXPECTED_TARBALL);
	});

	test("excludes source, docs, tests, credentials, and development tooling", () => {
		for (const path of tarballPaths) {
			expect(path.startsWith("src/")).toBe(false);
			expect(path.startsWith("docs/")).toBe(false);
			expect(path.startsWith("tests/")).toBe(false);
			expect(path.startsWith("scripts/")).toBe(false);
			expect(path.startsWith("node_modules/")).toBe(false);
			expect(path.startsWith(".")).toBe(false);
			expect(path).not.toMatch(/\.env/);
			expect(path).not.toMatch(/^(?:index|tui|rpc)\.tsx?$/);
			expect(path).not.toMatch(/^(?:bun\.lock|tsconfig\.json)$/);
		}
	});
});

describe("README Desktop GUI statement", () => {
	const readme = read("README.md");

	test("is experimental, version-qualified, and keeps web/V1/forks unsupported", () => {
		expect(readme).toContain("Desktop GUI (experimental)");
		expect(readme).toContain("`@opencode/plugin` `2.2.0`");
		expect(readme).toContain("Desktop `2.2.1`");
		expect(readme).toContain("Web, V1, and OpenCode forks are not supported.");
		expect(readme).toContain("exports five entrypoints");
	});
});
