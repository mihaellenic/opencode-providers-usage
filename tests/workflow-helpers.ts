import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
// Built without a literal dollar-brace so Biome does not flag GitHub expression text.
export const OPEN_EXPR = `\${{`;
export const read = (path: string): string =>
	readFileSync(join(root, path), "utf8");

/** Extract a top-level job block so assertions cannot match another job. */
export function jobBlock(source: string, name: string): string {
	const marker = `\n  ${name}:\n`;
	const start = source.indexOf(marker);
	if (start === -1) throw new Error(`job ${name} not found`);
	const rest = source.slice(start + marker.length);
	const next = rest.search(/\n {2}[a-zA-Z0-9_-]+:\n/);
	return next === -1 ? rest : rest.slice(0, next);
}

/** Collect `run:` bodies, single-line or block scalar, so shell can be inspected. */
export function runBlocks(source: string): string[] {
	const blocks: string[] = [];
	let current: string[] | undefined;
	let blockIndent = 0;
	for (const line of source.split("\n")) {
		if (current === undefined) {
			const match = /^(\s*)(?:-\s+)?run: \|\s*$/.exec(line);
			if (match) {
				current = [];
				blockIndent = match[1]?.length ?? 0;
				continue;
			}
			const single = /^(\s*)(?:-\s+)?run:\s+(.+)$/.exec(line);
			if (single?.[2]) blocks.push(single[2]);
			continue;
		}
		if (line.trim() === "") {
			current.push(line);
			continue;
		}
		const indent = line.length - line.trimStart().length;
		if (indent <= blockIndent) {
			blocks.push(current.join("\n"));
			current = undefined;
		} else {
			current.push(line);
		}
	}
	if (current !== undefined) blocks.push(current.join("\n"));
	return blocks;
}

/** Extract a named step's inline shell body so it can run without a GitHub runner. */
export function runBlock(source: string, stepName: string): string {
	const lines = source.split("\n");
	const stepIndex = lines.findIndex(
		(line) => line.trim() === `- name: ${stepName}`,
	);
	if (stepIndex === -1) throw new Error(`step ${stepName} not found`);
	const first = lines[stepIndex] as string;
	const stepIndent = first.length - first.trimStart().length;
	let stepEnd = lines.length;
	for (let index = stepIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] as string;
		if (line.trim() === "") continue;
		const indent = line.length - line.trimStart().length;
		if (indent === stepIndent && line.trimStart().startsWith("- ")) {
			stepEnd = index;
			break;
		}
	}
	const step = lines.slice(stepIndex, stepEnd);
	const runIndex = step.findIndex((line) => /^\s*run:\s*\|\s*$/.test(line));
	if (runIndex === -1)
		throw new Error(`step ${stepName} has no multi-line run body`);
	const runLine = step[runIndex] as string;
	const runIndent = runLine.length - runLine.trimStart().length;
	const body: string[] = [];
	for (let index = runIndex + 1; index < step.length; index += 1) {
		const line = step[index] as string;
		if (line.trim() === "") {
			body.push("");
			continue;
		}
		const indent = line.length - line.trimStart().length;
		if (indent <= runIndent) break;
		body.push(line.slice(runIndent + 2));
	}
	return body.join("\n").trimEnd();
}
