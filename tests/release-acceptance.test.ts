import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	allowedArtifactFile,
	bannedArtifactContent,
	blockingAuditDetail,
	type CommandResult,
	classifyPublishedLookup,
	classifyRegistryLookup,
	createArtifactMetadata,
	parseAcceptanceArgs,
	peerInstallSpecs,
	preserveArtifact,
	publishedArtifactProblem,
	registryGuardDecision,
	requireSingleTarball,
	sha256File,
	sha512SriFile,
	summarizeBunAudit,
	summarizeNpmAudit,
	validateArtifactListing,
	validateArtifactManifest,
	validateArtifactMetadata,
	validateBundleImports,
	validateConsumerExports,
	validateRootShims,
	verifyPublishedArtifact,
} from "../scripts/release-acceptance";

const PACKAGE = "opencode-providers-usage";
const VERSION = "0.1.0";
const HOST_PACKAGES = new Set([
	"@opencode/plugin",
	"@opencode/theme",
	"@opentui/core",
	"@opentui/solid",
	"solid-js",
]);

const result = (code: number, stdout = "", stderr = ""): CommandResult => ({
	code,
	stdout,
	stderr,
});

const e404 = JSON.stringify({
	error: {
		code: "E404",
		summary: "No match found",
		detail: "The requested resource could not be found.",
	},
});

const networkError = JSON.stringify({
	error: {
		code: "ENOTFOUND",
		summary: "network request failed",
		detail: "getaddrinfo ENOTFOUND registry.npmjs.org",
	},
});

const metadataInput = {
	name: PACKAGE,
	version: VERSION,
	filename: `${PACKAGE}-${VERSION}.tgz`,
	path: `/tmp/${PACKAGE}-${VERSION}.tgz`,
	integrity: "sha512-abc",
	shasum: "abc",
	sha256: "def",
};

const EXPORTS = {
	".": "./dist/index.js",
	"./server": "./dist/index.js",
	"./tui": "./dist/tui.js",
	"./rpc": "./dist/rpc.js",
};

const PEERS = {
	"@opencode/theme": "2.1.4",
	"@opentui/core": ">=0.6.8",
	"@opentui/solid": ">=0.6.8",
	"solid-js": ">=1.9.0",
};

const goodManifest = (): Record<string, unknown> => ({
	name: PACKAGE,
	version: VERSION,
	license: "MIT",
	main: "./dist/index.js",
	publishConfig: { access: "public" },
	exports: structuredClone(EXPORTS),
	scripts: { prepack: "bun run build" },
	dependencies: { "@opencode/plugin": "2.1.4" },
	peerDependencies: PEERS,
});

const expectedIdentity = { name: PACKAGE, version: VERSION };

describe("allowedArtifactFile", () => {
	test("accepts exactly the nine published artifact paths", () => {
		for (const path of [
			"package/package.json",
			"package/README.md",
			"package/LICENSE",
			"package/index.js",
			"package/tui.js",
			"package/rpc.js",
			"package/dist/index.js",
			"package/dist/rpc.js",
			"package/dist/tui.js",
		]) {
			expect(allowedArtifactFile(path)).toBe(true);
		}
	});

	test("rejects undeclared paths, source, docs, tests, and tooling", () => {
		for (const path of [
			"package/docs/internal.md",
			"package/dist/tui.js.map",
			"package/dist/other.js",
			"package/src/tui.tsx",
			"package/index.ts",
			"package/tui.tsx",
			"package/tests/package.test.ts",
			"package/scripts/build.ts",
			"package/bun.lock",
			"package/tsconfig.json",
			"package/.npmrc",
			"package/.env",
			"package/package.json.bak",
			"package/task-4-report.md",
			"package/dist/",
			"",
		]) {
			expect(allowedArtifactFile(path)).toBe(false);
		}
	});
});

describe("validateArtifactListing", () => {
	const allowed = [
		"package/package.json",
		"package/README.md",
		"package/LICENSE",
		"package/index.js",
		"package/tui.js",
		"package/rpc.js",
		"package/dist/index.js",
		"package/dist/rpc.js",
		"package/dist/tui.js",
	];

	test("accepts the exact listing in any order", () => {
		expect(() => validateArtifactListing([...allowed].reverse())).not.toThrow();
	});

	test("rejects an unexpected file in the tarball", () => {
		expect(() =>
			validateArtifactListing([...allowed, "package/dist/tui.js.map"]),
		).toThrow("undeclared artifact path(s): package/dist/tui.js.map");
	});

	test("rejects a missing expected file", () => {
		expect(() =>
			validateArtifactListing(
				allowed.filter((entry) => entry !== "package/rpc.js"),
			),
		).toThrow("missing artifact path(s): package/rpc.js");
	});

	test("rejects duplicated entries", () => {
		expect(() =>
			validateArtifactListing([...allowed, "package/README.md"]),
		).toThrow("duplicate");
	});
});

describe("bannedArtifactContent", () => {
	test("flags internal report markers", () => {
		expect(
			bannedArtifactContent("see task-4-report.md for details", "/Users/miha"),
		).toBe(true);
		expect(bannedArtifactContent("tasks-4-report", "/Users/miha")).toBe(false);
	});

	test("flags PEM private key blocks", () => {
		for (const block of [
			"BEGIN PRIVATE KEY",
			"BEGIN RSA PRIVATE KEY",
			"BEGIN OPENSSH PRIVATE KEY",
			"-----BEGIN EC PRIVATE KEY-----",
		]) {
			expect(bannedArtifactContent(block, "/Users/miha")).toBe(true);
		}
		expect(
			bannedArtifactContent(
				"PRIVATE KEY handling is documented",
				"/Users/miha",
			),
		).toBe(false);
	});

	test("flags the absolute source checkout path", () => {
		expect(
			bannedArtifactContent("/Users/miha/x/dist/tui.js content", "/Users/miha"),
		).toBe(true);
		expect(bannedArtifactContent("normal js", "/Users/miha")).toBe(false);
	});

	test("does not flag an empty source root", () => {
		expect(bannedArtifactContent("normal js", "")).toBe(false);
	});

	test("accepts ordinary bundled output", () => {
		expect(
			bannedArtifactContent(
				'import { x } from "@opentui/core"\nexport default x',
				"/Users/miha",
			),
		).toBe(false);
	});
});

describe("classifyRegistryLookup", () => {
	test("recognises npm's --json E404 as unpublished", () => {
		expect(
			classifyRegistryLookup(result(1, e404, "npm error code E404")),
		).toEqual({ status: "unpublished" });
	});

	test("does not treat auth, forbidden, or network errors as unpublished", () => {
		const outage = classifyRegistryLookup(
			result(1, networkError, "npm error network"),
		);
		expect(outage.status).toBe("error");
		expect(outage.status === "error" ? outage.code : undefined).toBe(
			"ENOTFOUND",
		);

		for (const code of ["E401", "E403"]) {
			const auth = classifyRegistryLookup(
				result(1, JSON.stringify({ error: { code } }), ""),
			);
			expect(auth.status).toBe("error");
			expect(auth.status === "error" ? auth.code : undefined).toBe(code);
		}
	});

	test("fails closed on unparsable error output", () => {
		const output = classifyRegistryLookup(
			result(1, "something went wrong", ""),
		);
		expect(output.status).toBe("error");
		expect(output.status === "error" ? output.detail : "").toContain(
			"something went wrong",
		);
	});

	test("fails closed on truncated JSON error output", () => {
		expect(
			classifyRegistryLookup(result(1, '{"error":{"code":"E40', "")).status,
		).toBe("error");
	});

	test("reads a published exact version", () => {
		expect(classifyRegistryLookup(result(0, '"0.1.0"'))).toEqual({
			status: "published",
			version: "0.1.0",
		});
		expect(classifyRegistryLookup(result(0, '["0.1.0"]'))).toEqual({
			status: "published",
			version: "0.1.0",
		});
	});

	test("rejects a success response without a version", () => {
		expect(classifyRegistryLookup(result(0, "{}")).status).toBe("error");
		expect(classifyRegistryLookup(result(0, "")).status).toBe("error");
	});
});

describe("registryGuardDecision", () => {
	test("allows an unpublished version", () => {
		expect(
			registryGuardDecision(
				{ status: "unpublished" },
				{ allowPublished: false },
			).ok,
		).toBe(true);
	});

	test("hard-fails a duplicate registry version by default", () => {
		const decision = registryGuardDecision(
			{ status: "published", version: "0.1.0" },
			{ allowPublished: false },
		);
		expect(decision.ok).toBe(false);
		expect(decision.ok ? "" : decision.detail).toContain("already published");
	});

	test("allows an explicit local duplicate bypass with a warning", () => {
		const decision = registryGuardDecision(
			{ status: "published", version: "0.1.0" },
			{ allowPublished: true },
		);
		expect(decision.ok).toBe(true);
		expect(decision.ok ? decision.warning : "").toContain("--allow-published");
	});

	test("never bypasses a registry error, even with --allow-published", () => {
		const decision = registryGuardDecision(
			{ status: "error", code: "ENOTFOUND", detail: "network down" },
			{ allowPublished: true },
		);
		expect(decision.ok).toBe(false);
		expect(decision.ok ? "" : decision.detail).toContain("refusing to guess");
	});
});

describe("parseAcceptanceArgs", () => {
	test("requires an explicit output directory for acceptance", () => {
		expect(() => parseAcceptanceArgs([], {})).toThrow(
			"--output-dir is required",
		);
	});

	test("requires an absolute output directory", () => {
		expect(() => parseAcceptanceArgs(["--output-dir", "artifact"], {})).toThrow(
			"absolute",
		);
		expect(() => parseAcceptanceArgs(["--output-dir=artifact"], {})).toThrow(
			"absolute",
		);
	});

	test("accepts both absolute output-directory forms", () => {
		expect(parseAcceptanceArgs(["--output-dir", "/tmp/out"], {})).toEqual({
			mode: "accept",
			outputDir: "/tmp/out",
			allowPublished: false,
		});
		expect(parseAcceptanceArgs(["--output-dir=/tmp/out"], {})).toEqual({
			mode: "accept",
			outputDir: "/tmp/out",
			allowPublished: false,
		});
	});

	test("accepts explicit local duplicate validation", () => {
		expect(
			parseAcceptanceArgs(
				["--output-dir", "/tmp/out", "--allow-published"],
				{},
			),
		).toEqual({
			mode: "accept",
			outputDir: "/tmp/out",
			allowPublished: true,
		});
	});

	test("refuses the duplicate bypass in CI", () => {
		expect(() =>
			parseAcceptanceArgs(["--output-dir", "/tmp/out", "--allow-published"], {
				CI: "true",
			}),
		).toThrow("CI must always fail");
		expect(() =>
			parseAcceptanceArgs(["--output-dir", "/tmp/out", "--allow-published"], {
				GITHUB_ACTIONS: "true",
			}),
		).toThrow("CI must always fail");
	});

	test("parses verification metadata mode", () => {
		expect(
			parseAcceptanceArgs(["--verify-published", "/tmp/artifact.json"], {}),
		).toEqual({
			mode: "verify",
			metadataPath: "/tmp/artifact.json",
		});
	});

	test("rejects mixed or unknown modes", () => {
		expect(() =>
			parseAcceptanceArgs(
				[
					"--verify-published",
					"/tmp/artifact.json",
					"--output-dir",
					"/tmp/out",
				],
				{},
			),
		).toThrow();
		expect(() =>
			parseAcceptanceArgs(
				["--verify-published", "/tmp/artifact.json", "--allow-published"],
				{},
			),
		).toThrow();
		expect(() => parseAcceptanceArgs(["--wat"], {})).toThrow(
			"unknown argument",
		);
	});

	test("never accepts a publish flag", () => {
		expect(() =>
			parseAcceptanceArgs(["--output-dir", "/tmp/out", "--publish"], {}),
		).toThrow("unknown argument");
	});
});

describe("artifact metadata", () => {
	test("creates metadata only for the matching artifact filename", () => {
		expect(createArtifactMetadata(metadataInput)).toEqual(metadataInput);
		expect(() =>
			createArtifactMetadata({ ...metadataInput, filename: "other.tgz" }),
		).toThrow("does not match");
		expect(() =>
			createArtifactMetadata({
				...metadataInput,
				filename: `${PACKAGE}-9.9.9.tgz`,
			}),
		).toThrow("does not match");
	});

	test("requires every field and an npm SRI integrity", () => {
		expect(() =>
			createArtifactMetadata({ ...metadataInput, integrity: "" }),
		).toThrow("missing");
		expect(() =>
			createArtifactMetadata({ ...metadataInput, integrity: "sha256-abc" }),
		).toThrow("sha512");
	});

	test("validates metadata read back from disk", () => {
		expect(validateArtifactMetadata(metadataInput)).toEqual(metadataInput);
		expect(() => validateArtifactMetadata(null)).toThrow("not an object");
		const { path: _path, ...missingPath } = metadataInput;
		expect(() => validateArtifactMetadata(missingPath)).toThrow("path");
	});
});

describe("file hashes", () => {
	test("computes the known SHA-256 and sha512 SRI of an empty file", () => {
		const dir = mkdtempSync(join(tmpdir(), "release-hash-"));
		try {
			const empty = join(dir, "empty");
			writeFileSync(empty, "");
			expect(sha256File(empty)).toBe(
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			);
			expect(sha512SriFile(empty)).toBe(
				"sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("preserveArtifact", () => {
	const helloIntegrity =
		"sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==";
	const helloSha256 =
		"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

	test("copies the accepted tarball and writes matching metadata", () => {
		const dir = mkdtempSync(join(tmpdir(), "release-preserve-"));
		try {
			const source = join(dir, `${PACKAGE}-${VERSION}.tgz`);
			const outputDir = join(dir, "output");
			writeFileSync(source, "hello");
			const metadata = preserveArtifact({
				source,
				outputDir,
				name: PACKAGE,
				version: VERSION,
				filename: `${PACKAGE}-${VERSION}.tgz`,
				integrity: helloIntegrity,
				shasum: helloSha256,
			});

			expect(metadata.path).toBe(join(outputDir, `${PACKAGE}-${VERSION}.tgz`));
			expect(readFileSync(metadata.path, "utf8")).toBe("hello");
			expect(metadata.sha256).toBe(helloSha256);
			expect(sha512SriFile(metadata.path)).toBe(helloIntegrity);
			expect(
				JSON.parse(readFileSync(join(outputDir, "artifact.json"), "utf8")),
			).toEqual(metadata);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects a tarball whose bytes do not match npm's integrity", () => {
		const dir = mkdtempSync(join(tmpdir(), "release-preserve-bad-"));
		try {
			const source = join(dir, `${PACKAGE}-${VERSION}.tgz`);
			const outputDir = join(dir, "output");
			writeFileSync(source, "hello");
			expect(() =>
				preserveArtifact({
					source,
					outputDir,
					name: PACKAGE,
					version: VERSION,
					filename: `${PACKAGE}-${VERSION}.tgz`,
					integrity: "sha512-wrong",
					shasum: "abc",
				}),
			).toThrow("does not match npm pack integrity");
			expect(existsSync(join(outputDir, "artifact.json"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("validateArtifactManifest", () => {
	test("accepts the approved manifest contract", () => {
		expect(() =>
			validateArtifactManifest(goodManifest(), expectedIdentity),
		).not.toThrow();
	});

	test("rejects a wrong package name or version", () => {
		expect(() =>
			validateArtifactManifest(
				{ ...goodManifest(), name: "other-package" },
				expectedIdentity,
			),
		).toThrow("wrong package identity");
		expect(() =>
			validateArtifactManifest(
				{ ...goodManifest(), version: "0.1.1" },
				expectedIdentity,
			),
		).toThrow("wrong package identity");
	});

	test("rejects a changed export target or a missing export", () => {
		const retargeted = goodManifest();
		retargeted.exports = { ...EXPORTS, "./tui": "./src/tui.tsx" };
		expect(() =>
			validateArtifactManifest(retargeted, expectedIdentity),
		).toThrow("export");

		const missing = goodManifest();
		const { "./rpc": _rpc, ...withoutRpc } = EXPORTS;
		missing.exports = withoutRpc;
		expect(() => validateArtifactManifest(missing, expectedIdentity)).toThrow(
			"export",
		);

		const extra = goodManifest();
		extra.exports = { ...EXPORTS, "./types": { types: "./dist/index.d.ts" } };
		expect(() => validateArtifactManifest(extra, expectedIdentity)).toThrow(
			"export",
		);
	});

	test("rejects a changed main entry", () => {
		expect(() =>
			validateArtifactManifest(
				{ ...goodManifest(), main: "./src/index.ts" },
				expectedIdentity,
			),
		).toThrow("main");
	});

	test("rejects a non-MIT license or non-public access", () => {
		expect(() =>
			validateArtifactManifest(
				{ ...goodManifest(), license: "ISC" },
				expectedIdentity,
			),
		).toThrow("MIT");
		expect(() =>
			validateArtifactManifest(
				{ ...goodManifest(), publishConfig: { access: "restricted" } },
				expectedIdentity,
			),
		).toThrow("public");
	});

	test("rejects consumer install lifecycle hooks", () => {
		for (const hook of ["preinstall", "install", "postinstall"]) {
			expect(() =>
				validateArtifactManifest(
					{ ...goodManifest(), scripts: { [hook]: "node x.js" } },
					expectedIdentity,
				),
			).toThrow(`consumer lifecycle hook present: ${hook}`);
		}
	});

	test("rejects a non-object manifest", () => {
		expect(() => validateArtifactManifest(null, expectedIdentity)).toThrow(
			"not an object",
		);
	});
});

describe("validateBundleImports", () => {
	const tuiCode = [
		'import { createSignal } from "solid-js";',
		'import { createTuiApi } from "@opencode/plugin/tui";',
		'import { Box } from "@opentui/core";',
		'import { jsx } from "@opentui/solid/jsx-runtime";',
		'import { plugin } from "@opencode/plugin";',
		'import { readFile } from "node:fs/promises";',
		"export default plugin;",
	].join("\n");

	const indexCode = [
		'import { plugin } from "@opencode/plugin";',
		'import { randomUUID } from "node:crypto";',
	].join("\n");

	test("accepts a bundle whose host imports stay external", () => {
		expect(() =>
			validateBundleImports("dist/tui.js", tuiCode, HOST_PACKAGES),
		).not.toThrow();
		expect(() =>
			validateBundleImports("dist/index.js", indexCode, HOST_PACKAGES),
		).not.toThrow();
	});

	test("fails when a required host runtime is bundled instead of imported", () => {
		const bundled = tuiCode.replace(
			'import { createSignal } from "solid-js";',
			"function createSignal() {}",
		);
		expect(() =>
			validateBundleImports("dist/tui.js", bundled, HOST_PACKAGES),
		).toThrow("host runtime is not external: solid-js");
	});

	test("fails when a required external is missing from the TUI bundle", () => {
		const missing = tuiCode.replace('import { Box } from "@opentui/core";', "");
		expect(() =>
			validateBundleImports("dist/tui.js", missing, HOST_PACKAGES),
		).toThrow("@opentui/core");
	});

	test("fails on relative, absolute, checkout-source, or undeclared imports", () => {
		expect(() =>
			validateBundleImports(
				"dist/index.js",
				`${indexCode}\nimport "./helper.js";`,
				HOST_PACKAGES,
			),
		).toThrow("relative");
		expect(() =>
			validateBundleImports(
				"dist/index.js",
				`${indexCode}\nimport "/abs/x.js";`,
				HOST_PACKAGES,
			),
		).toThrow("relative");
		expect(() =>
			validateBundleImports(
				"dist/index.js",
				`${indexCode}\nimport "left-pad";`,
				HOST_PACKAGES,
			),
		).toThrow("undeclared import: left-pad");
		expect(() =>
			validateBundleImports(
				"dist/index.js",
				`${indexCode}\nconst p = "src/provider.ts";`,
				HOST_PACKAGES,
			),
		).toThrow("checkout-only");
	});
});

describe("validateRootShims", () => {
	const shims = {
		"index.js": 'export { default } from "./dist/index.js"',
		"tui.js": 'export { default } from "./dist/tui.js"',
		"rpc.js": 'export * from "./dist/rpc.js"',
	};

	test("accepts the exact root shim contents", () => {
		expect(() => validateRootShims(shims)).not.toThrow();
		expect(() =>
			validateRootShims({ ...shims, "index.js": `${shims["index.js"]}\n` }),
		).not.toThrow();
	});

	test("rejects a shim that points outside dist or is missing", () => {
		expect(() =>
			validateRootShims({
				...shims,
				"index.js": 'export { default } from "./src/index.ts"',
			}),
		).toThrow("index.js");
		const { "rpc.js": _rpc, ...withoutRpc } = shims;
		expect(() => validateRootShims(withoutRpc)).toThrow("rpc.js");
	});
});

describe("peerInstallSpecs", () => {
	test("returns the host peers as exact npm specs for the consumer install", () => {
		expect(peerInstallSpecs({ peerDependencies: PEERS })).toEqual([
			"@opencode/theme@2.1.4",
			"@opentui/core@>=0.6.8",
			"@opentui/solid@>=0.6.8",
			"solid-js@>=1.9.0",
		]);
	});

	test("returns no specs when no peers are declared", () => {
		expect(peerInstallSpecs({})).toEqual([]);
	});
});

describe("requireSingleTarball", () => {
	test("accepts exactly the expected tarball", () => {
		expect(() =>
			requireSingleTarball(
				[`${PACKAGE}-${VERSION}.tgz`],
				`${PACKAGE}-${VERSION}.tgz`,
			),
		).not.toThrow();
	});

	test("fails when npm produced zero or several tarballs", () => {
		expect(() => requireSingleTarball([], `${PACKAGE}-${VERSION}.tgz`)).toThrow(
			"expected exactly one tarball",
		);
		expect(() =>
			requireSingleTarball(
				[`${PACKAGE}-${VERSION}.tgz`, `${PACKAGE}-${VERSION}-extra.tgz`],
				`${PACKAGE}-${VERSION}.tgz`,
			),
		).toThrow("expected exactly one tarball");
	});

	test("fails on an unexpected tarball name", () => {
		expect(() =>
			requireSingleTarball(["other-9.9.9.tgz"], `${PACKAGE}-${VERSION}.tgz`),
		).toThrow("unexpected artifact");
	});
});

describe("validateConsumerExports", () => {
	const consumerDir = "/scratch/consumer";
	const installed = (target: string) =>
		`${consumerDir}/node_modules/${PACKAGE}/${target.replace(/^\.\//, "")}`;
	const goodResults = () => [
		{
			specifier: ".",
			resolved: installed("dist/index.js"),
			hasDefault: true,
			keys: ["default"],
		},
		{
			specifier: "./server",
			resolved: installed("dist/index.js"),
			hasDefault: true,
			keys: ["default"],
		},
		{
			specifier: "./tui",
			resolved: installed("dist/tui.js"),
			hasDefault: true,
			keys: ["default"],
		},
		{
			specifier: "./rpc",
			resolved: installed("dist/rpc.js"),
			hasDefault: false,
			keys: ["QuotaRpc"],
		},
	];

	test("accepts all four exports resolved from the installed consumer copy", () => {
		expect(() =>
			validateConsumerExports(goodResults(), {
				consumerDir,
				name: PACKAGE,
				exports: EXPORTS,
			}),
		).not.toThrow();
	});

	test("fails when an export resolves to the wrong target", () => {
		const results = goodResults();
		results[3] = {
			specifier: "./rpc",
			resolved: installed("dist/tui.js"),
			hasDefault: false,
			keys: ["QuotaRpc"],
		};
		expect(() =>
			validateConsumerExports(results, {
				consumerDir,
				name: PACKAGE,
				exports: EXPORTS,
			}),
		).toThrow("./rpc");
	});

	test("fails when an export resolves outside the consumer install (source checkout)", () => {
		const results = goodResults();
		results[2] = {
			specifier: "./tui",
			resolved:
				"/Users/miha/Projects/opencode/opencode-providers-usage/dist/tui.js",
			hasDefault: true,
			keys: ["default"],
		};
		expect(() =>
			validateConsumerExports(results, {
				consumerDir,
				name: PACKAGE,
				exports: EXPORTS,
			}),
		).toThrow("outside the consumer");
	});

	test("fails when an export is missing or exposes no usable module", () => {
		expect(() =>
			validateConsumerExports(goodResults().slice(0, 3), {
				consumerDir,
				name: PACKAGE,
				exports: EXPORTS,
			}),
		).toThrow("./rpc");

		const results = goodResults();
		results[2] = {
			specifier: "./tui",
			resolved: installed("dist/tui.js"),
			hasDefault: false,
			keys: [],
		};
		expect(() =>
			validateConsumerExports(results, {
				consumerDir,
				name: PACKAGE,
				exports: EXPORTS,
			}),
		).toThrow("./tui");
	});

	test("fails when the server and root exports disagree", () => {
		const results = goodResults();
		results[1] = {
			specifier: "./server",
			resolved: installed("dist/rpc.js"),
			hasDefault: false,
			keys: ["QuotaRpc"],
		};
		expect(() =>
			validateConsumerExports(results, {
				consumerDir,
				name: PACKAGE,
				exports: EXPORTS,
			}),
		).toThrow("./server");
	});
});

const zeroNpmAudit = JSON.stringify({
	vulnerabilities: {},
	metadata: {
		vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
	},
});

const highNpmAudit = JSON.stringify({
	vulnerabilities: {
		seroval: {
			name: "seroval",
			severity: "high",
			via: [
				{
					url: "https://github.com/advisories/GHSA-test-high",
					title: "high advisory",
				},
			],
		},
	},
	metadata: {
		vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
	},
});

const criticalNpmAudit = JSON.stringify({
	vulnerabilities: {
		[PACKAGE]: {
			name: PACKAGE,
			severity: "critical",
			via: ["seroval"],
		},
	},
	metadata: {
		vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1 },
	},
});

const moderateNpmAudit = JSON.stringify({
	vulnerabilities: {
		"some-lib": {
			name: "some-lib",
			severity: "moderate",
			via: [{ url: "https://example/advisory/1" }],
		},
	},
	metadata: {
		vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 },
	},
});

describe("summarizeNpmAudit", () => {
	test("accepts a clean audit", () => {
		const summary = summarizeNpmAudit(zeroNpmAudit);
		expect(summary.high).toBe(0);
		expect(summary.critical).toBe(0);
		expect(summary.entries).toEqual([]);
	});

	test("reports high and critical entries with advisory identifiers", () => {
		const high = summarizeNpmAudit(highNpmAudit);
		expect(high.high).toBe(1);
		expect(high.entries).toEqual([
			{
				name: "seroval",
				severity: "high",
				advisories: ["https://github.com/advisories/GHSA-test-high"],
			},
		]);

		const critical = summarizeNpmAudit(criticalNpmAudit);
		expect(critical.critical).toBe(1);
		expect(critical.entries[0]?.advisories).toEqual(["seroval"]);
	});

	test("fails closed on malformed or network-error output", () => {
		expect(() => summarizeNpmAudit("not json")).toThrow("not JSON");
		expect(() => summarizeNpmAudit("")).toThrow("not JSON");
		expect(() =>
			summarizeNpmAudit(JSON.stringify({ error: { code: "ENETUNREACH" } })),
		).toThrow("vulnerabilities");
		expect(() =>
			summarizeNpmAudit(JSON.stringify({ vulnerabilities: {} })),
		).toThrow("metadata.vulnerabilities");
	});

	test("fails closed when npm's metadata disagrees with the entries", () => {
		const inconsistent = JSON.stringify({
			vulnerabilities: {},
			metadata: {
				vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
			},
		});
		expect(() => summarizeNpmAudit(inconsistent)).toThrow("disagrees");
	});

	test("fails closed on an unknown severity or malformed advisory", () => {
		expect(() =>
			summarizeNpmAudit(
				JSON.stringify({
					vulnerabilities: { pkg: { severity: "urgent", via: [] } },
					metadata: {
						vulnerabilities: {
							info: 0,
							low: 0,
							moderate: 0,
							high: 0,
							critical: 0,
						},
					},
				}),
			),
		).toThrow("unknown severity");

		expect(() =>
			summarizeNpmAudit(
				JSON.stringify({
					vulnerabilities: { pkg: { severity: "high", via: [null] } },
					metadata: {
						vulnerabilities: {
							info: 0,
							low: 0,
							moderate: 0,
							high: 1,
							critical: 0,
						},
					},
				}),
			),
		).toThrow("malformed advisory");
	});
});

describe("summarizeBunAudit", () => {
	test("treats an empty report as a clean audit", () => {
		const summary = summarizeBunAudit("{}");
		expect(summary.entries).toEqual([]);
		expect(summary.high).toBe(0);
		expect(summary.critical).toBe(0);
	});

	test("counts each advisory by severity with its identifier", () => {
		const summary = summarizeBunAudit(
			JSON.stringify({
				seroval: [
					{
						id: 1,
						url: "https://github.com/advisories/GHSA-a",
						severity: "high",
						title: "x",
					},
				],
				"left-pad": [
					{
						id: 2,
						url: "https://github.com/advisories/GHSA-b",
						severity: "moderate",
						title: "y",
					},
				],
			}),
		);
		expect(summary.high).toBe(1);
		expect(summary.critical).toBe(0);
		expect(summary.entries).toContainEqual({
			name: "seroval",
			severity: "high",
			advisories: ["https://github.com/advisories/GHSA-a"],
		});
	});

	test("fails closed on network-error text, empty output, and non-object reports", () => {
		expect(() => summarizeBunAudit("")).toThrow("not JSON");
		expect(() =>
			summarizeBunAudit("error: POST https://registry ConnectionRefused"),
		).toThrow("not JSON");
		expect(() => summarizeBunAudit("[]")).toThrow("not an object");
		expect(() => summarizeBunAudit("null")).toThrow("not an object");
	});

	test("fails closed on unknown severities and advisories without identifiers", () => {
		expect(() =>
			summarizeBunAudit(
				JSON.stringify({ pkg: [{ severity: "urgent", url: "x" }] }),
			),
		).toThrow("unknown severity");
		expect(() =>
			summarizeBunAudit(JSON.stringify({ pkg: [{ severity: "high" }] })),
		).toThrow("malformed advisory");
		expect(() => summarizeBunAudit(JSON.stringify({ pkg: "high" }))).toThrow(
			"malformed",
		);
	});
});

describe("blockingAuditDetail", () => {
	test("passes a clean or moderate-only audit", () => {
		expect(blockingAuditDetail(summarizeNpmAudit(zeroNpmAudit))).toBeNull();
		expect(blockingAuditDetail(summarizeNpmAudit(moderateNpmAudit))).toBeNull();
	});

	test("blocks any unhandled high or critical advisory and names it", () => {
		const high = blockingAuditDetail(summarizeNpmAudit(highNpmAudit));
		expect(high).toContain("1 high and 0 critical");
		expect(high).toContain("GHSA-test-high");

		const critical = blockingAuditDetail(summarizeNpmAudit(criticalNpmAudit));
		expect(critical).toContain("0 high and 1 critical");
	});

	test("blocks a high advisory with no exception input (no waiver mechanism)", () => {
		expect(blockingAuditDetail(summarizeNpmAudit(highNpmAudit))).not.toBeNull();
	});
});

describe("registry duplicate and published verification", () => {
	test("classifies a matching registry response", () => {
		const response = classifyPublishedLookup(
			result(
				0,
				JSON.stringify({ version: VERSION, "dist.integrity": "sha512-abc" }),
			),
		);
		expect(response).toEqual({
			status: "published",
			version: VERSION,
			integrity: "sha512-abc",
		});
	});

	test("classifies an E404 response as an error for bounded retry", () => {
		const response = classifyPublishedLookup(
			result(1, e404, "npm error code E404"),
		);
		expect(response.status).toBe("error");
		expect(response.status === "error" ? response.code : undefined).toBe(
			"E404",
		);
	});

	test("classifies auth, network, and malformed responses as errors", () => {
		const auth = classifyPublishedLookup(
			result(1, JSON.stringify({ error: { code: "E401" } })),
		);
		expect(auth.status === "error" ? auth.code : undefined).toBe("E401");
		const network = classifyPublishedLookup(result(1, networkError));
		expect(network.status === "error" ? network.code : undefined).toBe(
			"ENOTFOUND",
		);
		expect(classifyPublishedLookup(result(0, "[]")).status).toBe("error");
		expect(classifyPublishedLookup(result(0, "garbage")).status).toBe("error");
	});

	test("compares the accepted artifact with the published artifact", () => {
		expect(
			publishedArtifactProblem(
				{ version: VERSION, integrity: "sha512-abc" },
				metadataInput,
			),
		).toBeNull();
		expect(
			publishedArtifactProblem(
				{ version: "0.0.9", integrity: "sha512-abc" },
				metadataInput,
			),
		).toContain("version");
		expect(
			publishedArtifactProblem(
				{ version: VERSION, integrity: "sha512-other" },
				metadataInput,
			),
		).toContain("integrity");
	});

	test("retries bounded propagation errors before succeeding", async () => {
		const metadata = createArtifactMetadata(metadataInput);
		const waits: number[] = [];
		let calls = 0;
		const outcome = await verifyPublishedArtifact(
			metadata,
			() => {
				calls += 1;
				return calls < 3
					? { status: "error", code: "E404", detail: "not found yet" }
					: { status: "published", version: VERSION, integrity: "sha512-abc" };
			},
			{ attempts: 4, delayMs: 7, wait: async (ms) => void waits.push(ms) },
		);

		expect(outcome).toEqual({
			ok: true,
			detail: `registry ${PACKAGE}@${VERSION} matches accepted integrity`,
			attempts: 3,
		});
		expect(calls).toBe(3);
		expect(waits).toEqual([7, 7]);
	});

	test("allows five minutes of propagation waits by default and succeeds on the last lookup", async () => {
		let elapsedMs = 0;
		const outcome = await verifyPublishedArtifact(
			createArtifactMetadata(metadataInput),
			() =>
				elapsedMs < 300_000
					? { status: "error", code: "E404", detail: "not found yet" }
					: { status: "published", version: VERSION, integrity: "sha512-abc" },
			{
				wait: async (ms) => {
					elapsedMs += ms;
				},
			},
		);

		expect(outcome.ok).toBe(true);
		expect(elapsedMs).toBe(300_000);
		expect(outcome.attempts).toBe(61);
	});

	test("stops after five minutes of propagation waits by default if the version stays unavailable", async () => {
		let elapsedMs = 0;
		const outcome = await verifyPublishedArtifact(
			createArtifactMetadata(metadataInput),
			() => ({ status: "error", code: "E404", detail: "not found" }),
			{
				wait: async (ms) => {
					elapsedMs += ms;
				},
			},
		);

		expect(outcome.ok).toBe(false);
		expect(elapsedMs).toBe(300_000);
		expect(outcome.attempts).toBe(61);
	});

	test("retries auth and network errors with the same bound, never treating them as unpublished", async () => {
		let calls = 0;
		const outcome = await verifyPublishedArtifact(
			createArtifactMetadata(metadataInput),
			() => {
				calls += 1;
				return { status: "error", code: "E401", detail: "unauthorized" };
			},
			{ attempts: 3, delayMs: 1, wait: async () => {} },
		);
		expect(outcome.ok).toBe(false);
		expect(calls).toBe(3);
		expect(outcome.detail).toContain("E401");
	});

	test("stops after the bounded attempt count", async () => {
		const metadata = createArtifactMetadata(metadataInput);
		const waits: number[] = [];
		const outcome = await verifyPublishedArtifact(
			metadata,
			() => ({ status: "error", code: "E404", detail: "not found" }),
			{ attempts: 3, delayMs: 11, wait: async (ms) => void waits.push(ms) },
		);

		expect(outcome.ok).toBe(false);
		expect(outcome.attempts).toBe(3);
		expect(outcome.detail).toContain("after 3 attempt(s)");
		expect(waits).toEqual([11, 11]);
	});

	test("fails immediately when the registry serves different bytes", async () => {
		const metadata = createArtifactMetadata(metadataInput);
		let calls = 0;
		const outcome = await verifyPublishedArtifact(
			metadata,
			() => {
				calls += 1;
				return {
					status: "published",
					version: VERSION,
					integrity: "sha512-other",
				};
			},
			{ attempts: 5, wait: async () => {} },
		);

		expect(outcome.ok).toBe(false);
		expect(outcome.attempts).toBe(1);
		expect(calls).toBe(1);
		expect(outcome.detail).toContain("integrity");
	});

	test("fails immediately when the registry reports a different version", async () => {
		let calls = 0;
		const outcome = await verifyPublishedArtifact(
			createArtifactMetadata(metadataInput),
			() => {
				calls += 1;
				return {
					status: "published",
					version: "0.0.9",
					integrity: "sha512-abc",
				};
			},
			{ attempts: 5, wait: async () => {} },
		);
		expect(outcome.ok).toBe(false);
		expect(calls).toBe(1);
	});
});
