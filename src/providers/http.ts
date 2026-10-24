import { QuotaRequestError } from "../core/contracts";

export const QUOTA_TIMEOUT_MS = 10_000;
export const QUOTA_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * The complete request allowlist: an origin may only reach the exact paths it
 * is pinned to. Anything else is a configuration bug, never a network attempt.
 */
const ALLOWED_PATHS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["https://ollama.com", new Set(["/api/balance"])],
	[
		"https://chatgpt.com",
		new Set([
			"/backend-api/wham/usage",
			"/backend-api/wham/usage/chatpass/apps",
		]),
	],
]);

export type QuotaFetchInit = {
	method: "GET";
	headers: Record<string, string>;
	redirect: "error";
	signal: AbortSignal;
};

export type QuotaFetchResponse = {
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	readonly body: ReadableStream<Uint8Array> | null;
};

export type QuotaFetch = (
	url: string,
	init: QuotaFetchInit,
) => Promise<QuotaFetchResponse>;

export type QuotaTransportOptions = { timeoutMs?: number };

export type QuotaGetJson = (
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
) => Promise<unknown>;

function isAllowedUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		return false;
	}
	return ALLOWED_PATHS.get(parsed.origin)?.has(parsed.pathname) === true;
}

/**
 * Parses `Retry-After` in both allowed forms: delta seconds and HTTP-date.
 * Missing, negative, or malformed values simply yield no hint.
 */
function parseRetryAfterMs(value: string | null): number | undefined {
	if (value === null) {
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed === "" || trimmed.startsWith("-")) {
		return undefined;
	}
	if (/^\d+$/.test(trimmed)) {
		const seconds = Number(trimmed);
		return Number.isFinite(seconds) ? seconds * 1000 : undefined;
	}
	const retryAt = Date.parse(trimmed);
	if (Number.isNaN(retryAt)) {
		return undefined;
	}
	return Math.max(0, retryAt - Date.now());
}

async function discardBody(response: QuotaFetchResponse): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// A body that is already closed or errored needs no further cleanup.
	}
}

async function readBounded(response: QuotaFetchResponse): Promise<Uint8Array> {
	const declared = response.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		if (Number.isFinite(length) && length > QUOTA_MAX_RESPONSE_BYTES) {
			await discardBody(response);
			throw new QuotaRequestError("invalid_response");
		}
	}

	const stream = response.body;
	if (stream === null) {
		throw new QuotaRequestError("invalid_response");
	}

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (value === undefined) {
			continue;
		}
		total += value.byteLength;
		if (total > QUOTA_MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => {
				// The oversized body is discarded either way.
			});
			throw new QuotaRequestError("invalid_response");
		}
		chunks.push(value);
	}
	reader.releaseLock();

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
	let text: string;
	try {
		text = new TextDecoder().decode(bytes);
	} catch {
		throw new QuotaRequestError("invalid_response");
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new QuotaRequestError("invalid_response");
	}
}

/**
 * Only allowlisted reason codes leave this module. The original error is
 * deliberately dropped so no response body, request, or exception message can
 * escape through `message`, `stack`, or `cause`.
 */
function classifyFailure(error: unknown, timedOut: boolean): QuotaRequestError {
	if (error instanceof QuotaRequestError) {
		return error;
	}
	return new QuotaRequestError(timedOut ? "timeout" : "network_error");
}

function assertNotAborted(timedOut: boolean, callerSignal: AbortSignal): void {
	if (timedOut) {
		throw new QuotaRequestError("timeout");
	}
	if (callerSignal.aborted) {
		// Caller cancellation is not a provider signal; the coordinator discards
		// the result and this stays a plain transport failure.
		throw new QuotaRequestError("network_error");
	}
}

export function createQuotaTransport(
	fetchImpl: QuotaFetch,
	options: QuotaTransportOptions = {},
): QuotaGetJson {
	const timeoutMs = options.timeoutMs ?? QUOTA_TIMEOUT_MS;

	return async function requestQuotaJson(url, headers, callerSignal) {
		if (!isAllowedUrl(url)) {
			throw new QuotaRequestError("invalid_response");
		}
		if (callerSignal.aborted) {
			throw new QuotaRequestError("network_error");
		}

		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const cancel = () => controller.abort();
		callerSignal.addEventListener("abort", cancel, { once: true });

		try {
			if (callerSignal.aborted) {
				controller.abort();
			}
			const response = await fetchImpl(url, {
				method: "GET",
				headers,
				redirect: "error",
				signal: controller.signal,
			});
			assertNotAborted(timedOut, callerSignal);

			if (response.status === 429) {
				await discardBody(response);
				const retryAfterMs = parseRetryAfterMs(
					response.headers.get("retry-after"),
				);
				throw new QuotaRequestError("rate_limited", {
					status: 429,
					...(retryAfterMs === undefined ? {} : { retryAfterMs }),
				});
			}
			if (response.status < 200 || response.status > 299) {
				await discardBody(response);
				throw new QuotaRequestError("invalid_response", {
					status: response.status,
				});
			}

			const bytes = await readBounded(response);
			assertNotAborted(timedOut, callerSignal);
			return parseJson(bytes);
		} catch (error) {
			throw classifyFailure(error, timedOut);
		} finally {
			clearTimeout(timer);
			callerSignal.removeEventListener("abort", cancel);
		}
	};
}

const defaultTransport = createQuotaTransport((url, init) => fetch(url, init));

/** Shared bounded JSON GET transport for every provider adapter. */
export function getQuotaJson(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<unknown> {
	return defaultTransport(url, headers, signal);
}
