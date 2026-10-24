import { describe, expect, test } from "bun:test";
import { type QuotaReason, QuotaRequestError } from "../../src/core/contracts";
import {
	createQuotaTransport,
	getQuotaJson,
	QUOTA_MAX_RESPONSE_BYTES,
	QUOTA_TIMEOUT_MS,
	type QuotaFetch,
	type QuotaFetchInit,
	type QuotaFetchResponse,
} from "../../src/providers/http";

const SENTINEL = "sk-test-sentinel-do-not-leak";
const OLLAMA_BALANCE = "https://ollama.com/api/balance";
const OPENAI_USAGE = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_APPS = "https://chatgpt.com/backend-api/wham/usage/chatpass/apps";

const ALLOWED_URLS = [OLLAMA_BALANCE, OPENAI_USAGE, OPENAI_APPS];

type FetchCall = { url: string; init: QuotaFetchInit };

function syntheticFetch(
	respond: (
		url: string,
		init: QuotaFetchInit,
	) => QuotaFetchResponse | Promise<QuotaFetchResponse>,
): { fetchImpl: QuotaFetch; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const fetchImpl: QuotaFetch = async (url, init) => {
		calls.push({ url, init });
		return await respond(url, init);
	};
	return { fetchImpl, calls };
}

function signal(): AbortSignal {
	return new AbortController().signal;
}

function hangUntilAborted(
	abortSignal: AbortSignal,
): Promise<QuotaFetchResponse> {
	return new Promise<QuotaFetchResponse>((_resolve, reject) => {
		const abort = () => {
			reject(new DOMException(`aborted ${SENTINEL}`, "AbortError"));
		};
		if (abortSignal.aborted) {
			abort();
			return;
		}
		abortSignal.addEventListener("abort", abort, { once: true });
	});
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the request to fail");
}

function expectSanitized(
	error: unknown,
	reason: QuotaReason,
): QuotaRequestError {
	expect(error).toBeInstanceOf(QuotaRequestError);
	const quotaError = error as QuotaRequestError;
	expect(quotaError.name).toBe("QuotaRequestError");
	expect(quotaError.reason).toBe(reason);
	expect(quotaError.message).toBe(reason);
	expect(quotaError.cause).toBeUndefined();
	const rendered = [
		quotaError.message,
		quotaError.stack ?? "",
		String(quotaError),
		JSON.stringify(quotaError),
	];
	for (const text of rendered) {
		expect(text).not.toContain(SENTINEL);
	}
	return quotaError;
}

function jsonOfExactSize(size: number): string {
	const prefix = '{"p":"';
	const suffix = '"}';
	return `${prefix}${"a".repeat(size - prefix.length - suffix.length)}${suffix}`;
}

describe("quota transport allowlist", () => {
	test("accepts exactly the pinned (origin, path) pairs", async () => {
		for (const url of ALLOWED_URLS) {
			const { fetchImpl, calls } = syntheticFetch(
				() => new Response('{"ok":true}'),
			);
			const request = createQuotaTransport(fetchImpl);
			expect(await request(url, {}, signal())).toEqual({ ok: true });
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe(url);
		}
	});

	test("rejects every URL outside the allowlist without calling fetch", async () => {
		const rejected = [
			"https://ollama.com/api/other",
			"https://ollama.com/api/balance/",
			"https://ollama.com/backend-api/wham/usage",
			"https://chatgpt.com/api/balance",
			"https://chatgpt.com/backend-api/wham/usage/extra",
			"https://evil.example/api/balance",
			"https://ollama.com.evil.example/api/balance",
			"http://ollama.com/api/balance",
			"https://ollama.com/api/balance?account=1",
			"https://ollama.com/api/balance#fragment",
			"https://user:pass@ollama.com/api/balance",
			"not a url",
		];
		for (const url of rejected) {
			const { fetchImpl, calls } = syntheticFetch(() => {
				throw new Error(`fetch must not run for ${url}`);
			});
			const request = createQuotaTransport(fetchImpl);
			const error = await captureError(request(url, {}, signal()));
			expectSanitized(error, "invalid_response");
			expect(calls).toHaveLength(0);
		}
	});

	test("sends one redirect-free GET with the caller headers and signal", async () => {
		const { fetchImpl, calls } = syntheticFetch(
			() => new Response('{"ok":true}'),
		);
		const request = createQuotaTransport(fetchImpl);
		const callerSignal = signal();
		const headers = { authorization: `Bearer ${SENTINEL}` };
		await request(OLLAMA_BALANCE, headers, callerSignal);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.init.method).toBe("GET");
		expect(calls[0]?.init.redirect).toBe("error");
		expect(calls[0]?.init.headers).toBe(headers);
		expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
		expect(headers).toEqual({ authorization: `Bearer ${SENTINEL}` });
	});

	test("default transport rejects a non-allowlisted URL without network", async () => {
		const error = await captureError(
			getQuotaJson("https://evil.example/api/balance", {}, signal()),
		);
		expectSanitized(error, "invalid_response");
	});
});

describe("quota transport failure classification", () => {
	test("rejects 3xx redirect responses even if the fetch implementation follows none", async () => {
		const { fetchImpl, calls } = syntheticFetch(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "https://evil.example/steal" },
				}),
		);
		const request = createQuotaTransport(fetchImpl);
		const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
		const quotaError = expectSanitized(error, "invalid_response");
		expect(quotaError.status).toBe(302);
		expect(calls[0]?.init.redirect).toBe("error");
	});

	test("rejects a response body past the 1 MiB limit", async () => {
		const oversized = jsonOfExactSize(QUOTA_MAX_RESPONSE_BYTES + 1).replace(
			'"p":"',
			`"p":"${SENTINEL}`,
		);
		const { fetchImpl } = syntheticFetch(() => new Response(oversized));
		const request = createQuotaTransport(fetchImpl);
		const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
		expectSanitized(error, "invalid_response");
	});

	test("rejects an oversized content-length before reading the body", async () => {
		const { fetchImpl } = syntheticFetch(() => ({
			status: 200,
			headers: new Headers({
				"content-length": String(QUOTA_MAX_RESPONSE_BYTES + 1),
			}),
			body: new Response("{}").body,
		}));
		const request = createQuotaTransport(fetchImpl);
		const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
		expectSanitized(error, "invalid_response");
	});

	test("accepts a response body of exactly 1 MiB", async () => {
		const body = jsonOfExactSize(QUOTA_MAX_RESPONSE_BYTES);
		const { fetchImpl } = syntheticFetch(() => new Response(body));
		const request = createQuotaTransport(fetchImpl);
		expect(await request(OLLAMA_BALANCE, {}, signal())).toEqual({
			p: "a".repeat(QUOTA_MAX_RESPONSE_BYTES - '{"p":"'.length - '"}'.length),
		});
	});

	test("times out via the injected short timeout with a sanitized reason", async () => {
		expect(QUOTA_TIMEOUT_MS).toBe(10_000);
		const { fetchImpl } = syntheticFetch((_url, init) =>
			hangUntilAborted(init.signal),
		);
		const request = createQuotaTransport(fetchImpl, { timeoutMs: 20 });
		const startedAt = Date.now();
		const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
		expectSanitized(error, "timeout");
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});

	test("rejects an already-cancelled signal without calling fetch", async () => {
		const controller = new AbortController();
		controller.abort();
		const { fetchImpl, calls } = syntheticFetch(
			() => new Response('{"ok":true}'),
		);
		const request = createQuotaTransport(fetchImpl);
		const error = await captureError(
			request(OLLAMA_BALANCE, {}, controller.signal),
		);
		expectSanitized(error, "network_error");
		expect(calls).toHaveLength(0);
	});

	test("cancellation during flight aborts the request and stays sanitized", async () => {
		const controller = new AbortController();
		const { fetchImpl, calls } = syntheticFetch((_url, init) =>
			hangUntilAborted(init.signal),
		);
		const request = createQuotaTransport(fetchImpl);
		const pending = request(OLLAMA_BALANCE, {}, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(calls).toHaveLength(1);
		controller.abort();
		const error = await captureError(pending);
		expectSanitized(error, "network_error");
	});

	test("rejects malformed JSON without echoing the body", async () => {
		const { fetchImpl } = syntheticFetch(
			() => new Response(`{"broken":"${SENTINEL}"`),
		);
		const request = createQuotaTransport(fetchImpl);
		const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
		const quotaError = expectSanitized(error, "invalid_response");
		expect(quotaError.status).toBeUndefined();
	});

	test("classifies a body read failure as network_error without leaking its message", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error(`stream failed ${SENTINEL}`));
			},
		});
		const { fetchImpl } = syntheticFetch(
			() => new Response(body, { status: 200 }),
		);
		const request = createQuotaTransport(fetchImpl);
		const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
		expectSanitized(error, "network_error");
	});

	test("classifies a fetch rejection as network_error without leaking its message", async () => {
		const { fetchImpl } = syntheticFetch(() => {
			throw new TypeError(`socket exploded ${SENTINEL}`);
		});
		const request = createQuotaTransport(fetchImpl);
		const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
		expectSanitized(error, "network_error");
	});

	test("classifies non-429 HTTP failures as invalid_response with the status", async () => {
		for (const status of [400, 401, 403, 500, 503]) {
			const { fetchImpl } = syntheticFetch(
				() =>
					new Response(`{"error":"${SENTINEL}"}`, {
						status,
						headers: { "content-type": "application/json" },
					}),
			);
			const request = createQuotaTransport(fetchImpl);
			const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
			const quotaError = expectSanitized(error, "invalid_response");
			expect(quotaError.status).toBe(status);
			expect(quotaError.retryAfterMs).toBeUndefined();
		}
	});
});

describe("quota transport 429 handling", () => {
	test("maps 429 to rate_limited with Retry-After seconds", async () => {
		const { fetchImpl } = syntheticFetch(
			() =>
				new Response(`{"error":"${SENTINEL}"}`, {
					status: 429,
					headers: { "retry-after": "120" },
				}),
		);
		const request = createQuotaTransport(fetchImpl);
		const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
		const quotaError = expectSanitized(error, "rate_limited");
		expect(quotaError.status).toBe(429);
		expect(quotaError.retryAfterMs).toBe(120_000);
	});

	test("keeps an overflowing Retry-After as rate_limited without a hint", async () => {
		// A finite value in seconds whose millisecond conversion overflows, plus
		// the exponent spelling of the same magnitude. Neither may turn the
		// provider's rate limit into a wrong-reason invalid_response.
		const overflowingSeconds = `1${"0".repeat(308)}`;
		for (const retryAfter of [overflowingSeconds, "1e308"]) {
			const { fetchImpl } = syntheticFetch(
				() =>
					new Response("{}", {
						status: 429,
						headers: { "retry-after": retryAfter },
					}),
			);
			const request = createQuotaTransport(fetchImpl);
			const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
			const quotaError = expectSanitized(error, "rate_limited");
			expect(quotaError.status).toBe(429);
			expect(quotaError.retryAfterMs).toBeUndefined();
		}
	});

	test("maps 429 to rate_limited with a Retry-After HTTP-date", async () => {
		const retryAt = new Date(Date.now() + 60_000).toUTCString();
		const { fetchImpl } = syntheticFetch(
			() =>
				new Response(`{"error":"${SENTINEL}"}`, {
					status: 429,
					headers: { "retry-after": retryAt },
				}),
		);
		const request = createQuotaTransport(fetchImpl);
		const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
		const quotaError = expectSanitized(error, "rate_limited");
		expect(quotaError.status).toBe(429);
		expect(quotaError.retryAfterMs).toBeGreaterThan(50_000);
		expect(quotaError.retryAfterMs).toBeLessThanOrEqual(60_000);
	});

	test("omits retryAfterMs when Retry-After is missing or unparsable", async () => {
		for (const retryAfter of [undefined, "", "soon", "-5"]) {
			const headers: Record<string, string> =
				retryAfter === undefined ? {} : { "retry-after": retryAfter };
			const { fetchImpl } = syntheticFetch(
				() => new Response("{}", { status: 429, headers }),
			);
			const request = createQuotaTransport(fetchImpl);
			const error = await captureError(request(OLLAMA_BALANCE, {}, signal()));
			const quotaError = expectSanitized(error, "rate_limited");
			expect(quotaError.status).toBe(429);
			expect(quotaError.retryAfterMs).toBeUndefined();
		}
	});
});
