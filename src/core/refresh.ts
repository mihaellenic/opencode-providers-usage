import {
	type CoordinatorDeps,
	isQuotaRead,
	type QuotaCoordinator,
	type QuotaRead,
	type ResolvedQuotaSource,
	type SectionResult,
} from "./contracts";

/** Visible supported connections are polled at this cadence. */
export const QUOTA_POLL_MS = 60_000;
/** Minimum spacing between two request starts for the same provider. */
export const QUOTA_MANUAL_FLOOR_MS = 15_000;
/** A section older than this is never presented as current, even if the adapter
 * reported a later expiry. */
export const QUOTA_SNAPSHOT_MAX_AGE_MS = 90_000;
/** Coordinator backstop for the shared transport's own request timeout. */
export const QUOTA_REQUEST_TIMEOUT_MS = 10_000;
/** Repeated transient-failure backoff, capped at the last entry. */
export const QUOTA_BACKOFF_MS = [60_000, 120_000, 240_000, 300_000] as const;

/**
 * Failures that describe an unsupported or misconfigured connection rather
 * than a transient provider problem. None of them may start an automatic retry
 * loop: only an explicit refresh (or an observed identity change) tries again.
 */
const NO_AUTO_RETRY: ReadonlySet<string> = new Set([
	"companion_disabled",
	"companion_missing",
	"companion_expired",
	"unsupported_companion_storage",
	"invalid_companion",
	"app_registration_mismatch",
	"invalid_native_registration",
	"unsupported_auth_method",
	"no_validated_quota_source",
]);

type Attempt = {
	identityKey: string;
	controller: AbortController;
	promise: Promise<QuotaRead>;
};

type Entry = {
	providerID: string;
	listeners: Set<(value: QuotaRead) => void>;
	/** Identity of the last resolved source; server-local, never a UI claim. */
	identityKey?: string;
	snapshot?: QuotaRead;
	/** In-flight attempt shared by every consumer of this provider. */
	pending?: Attempt;
	resolving?: Promise<ResolvedQuotaSource | undefined>;
	resolveController?: AbortController;
	/** Start of the most recent request; drives the manual floor. */
	lastRequestAt?: number;
	/** Consecutive transient failures, for the capped backoff. */
	failures: number;
	cooldownUntil?: number;
	/** False while the last result must not be retried automatically. */
	autoRetry: boolean;
	timer?: unknown;
};

function hasSections(
	read: QuotaRead,
): read is Extract<QuotaRead, { sections: unknown[] }> {
	return "sections" in read;
}

function sectionIsCurrent(
	result: Extract<SectionResult, { state: "available" }>,
	now: number,
): boolean {
	return (
		now < result.expiresAt && now - result.fetchedAt < QUOTA_SNAPSHOT_MAX_AGE_MS
	);
}

/**
 * The pinned reason vocabulary has no "stale" code. A read with no snapshot (or
 * with only expired sections) reports `no_validated_quota_source`: no quota
 * result is currently validated for this provider. The RPC read path always
 * revalidates before returning, so users normally see a real provider reason;
 * this state exists for direct reads, identity invalidation, and unload.
 */
function emptyRead(now: number): QuotaRead {
	return {
		state: "unavailable",
		reason: "no_validated_quota_source",
		attemptedAt: now,
	};
}

function invalidResponseRead(now: number): QuotaRead {
	return { state: "unavailable", reason: "invalid_response", attemptedAt: now };
}

function timeoutRead(now: number): QuotaRead {
	return { state: "unavailable", reason: "timeout", attemptedAt: now };
}

/**
 * Applies freshness to a committed snapshot without inventing values. Each
 * available section expires independently at the earlier of its adapter
 * boundary (reset, credential expiry) and the 90-second cache limit. Explicit
 * failure sections stay until a new attempt replaces them.
 */
function currentView(snapshot: QuotaRead, now: number): QuotaRead {
	if (!hasSections(snapshot)) {
		return snapshot;
	}
	const sections = snapshot.sections.filter(
		(section) =>
			section.result.state !== "available" ||
			sectionIsCurrent(section.result, now),
	);
	if (sections.length === snapshot.sections.length) {
		return snapshot;
	}
	if (sections.length === 0) {
		return emptyRead(now);
	}
	const anyAvailable = sections.some(
		(section) => section.result.state === "available",
	);
	const anyUnavailable = sections.some(
		(section) => section.result.state !== "available",
	);
	return {
		...snapshot,
		state: anyAvailable && !anyUnavailable ? "available" : "partial",
		sections,
	};
}

/**
 * One refresh/cache/cancellation owner per server plugin runtime. Every mounted
 * UI view subscribes through `watch`; the coordinator, not the widgets, owns
 * the poll timer and the one in-flight request per provider. Two views of the
 * same provider therefore share a single request, and a provider with no
 * listeners is never polled.
 *
 * Deduplication is deliberately in-process only: separate OpenCode server
 * processes each own their coordinator and may each request the same quota.
 * No module-global singleton is used, because the host can load this module in
 * more than one plugin location.
 */
export function createQuotaCoordinator(
	deps: CoordinatorDeps,
): QuotaCoordinator {
	const entries = new Map<string, Entry>();
	let disposed = false;

	function entryFor(providerID: string): Entry {
		let entry = entries.get(providerID);
		if (entry === undefined) {
			entry = {
				providerID,
				listeners: new Set(),
				failures: 0,
				autoRetry: false,
			};
			entries.set(providerID, entry);
		}
		return entry;
	}

	function read(providerID: string): QuotaRead {
		const entry = entries.get(providerID);
		if (entry?.snapshot === undefined) {
			return emptyRead(deps.now());
		}
		return currentView(entry.snapshot, deps.now());
	}

	function notify(entry: Entry): void {
		if (entry.listeners.size === 0) {
			return;
		}
		const value = read(entry.providerID);
		for (const listener of [...entry.listeners]) {
			try {
				listener(value);
			} catch {
				// A broken view must never stop refreshes for the other views.
			}
		}
	}

	function clearPoll(entry: Entry): void {
		if (entry.timer !== undefined) {
			deps.clearTimer(entry.timer);
			entry.timer = undefined;
		}
	}

	/**
	 * Poll only while at least one view is subscribed and the last result is
	 * retryable. Unsupported, auth, and matching failures never schedule a
	 * timer; a new identity or an explicit refresh is required.
	 */
	function schedulePoll(entry: Entry): void {
		clearPoll(entry);
		if (disposed || entry.listeners.size === 0 || !entry.autoRetry) {
			return;
		}
		const now = deps.now();
		let due = (entry.lastRequestAt ?? now) + QUOTA_POLL_MS;
		if (entry.cooldownUntil !== undefined) {
			due = Math.max(due, entry.cooldownUntil);
		}
		entry.timer = deps.setTimer(
			() => {
				entry.timer = undefined;
				void refresh(entry.providerID);
			},
			Math.max(0, due - now),
		);
	}

	function commit(entry: Entry, value: QuotaRead): QuotaRead {
		entry.snapshot = value;
		if (hasSections(value)) {
			entry.failures = 0;
			entry.autoRetry = true;
			// A partial result can still carry the provider's Retry-After on a
			// failed section. The next poll must not undercut it.
			let retryAfterMs = 0;
			for (const section of value.sections) {
				if (section.result.state === "available") {
					continue;
				}
				const hint = section.result.retryAfterMs;
				if (hint !== undefined && hint > retryAfterMs) {
					retryAfterMs = hint;
				}
			}
			entry.cooldownUntil =
				retryAfterMs > 0 ? deps.now() + retryAfterMs : undefined;
		} else if (NO_AUTO_RETRY.has(value.reason)) {
			entry.failures = 0;
			entry.cooldownUntil = undefined;
			entry.autoRetry = false;
		} else {
			entry.failures += 1;
			const index = Math.min(entry.failures - 1, QUOTA_BACKOFF_MS.length - 1);
			const capped = QUOTA_BACKOFF_MS[index] ?? 300_000;
			const retryAfter = value.retryAfterMs;
			const delay =
				retryAfter !== undefined && retryAfter > capped ? retryAfter : capped;
			entry.cooldownUntil = deps.now() + delay;
			entry.autoRetry = true;
		}
		notify(entry);
		return read(entry.providerID);
	}

	/**
	 * Resolves the current source once for every concurrent consumer of the
	 * same provider. Resolution rereads the active connection/companion cache,
	 * so an account or cache change is observed on every refresh.
	 */
	function resolveSource(
		entry: Entry,
	): Promise<ResolvedQuotaSource | undefined> {
		if (entry.resolving !== undefined) {
			return entry.resolving;
		}
		const controller = new AbortController();
		entry.resolveController = controller;
		const promise = deps
			.resolve(entry.providerID, controller.signal)
			.then((resolved) => resolved)
			.catch(() => undefined)
			.finally(() => {
				if (entry.resolving === promise) {
					entry.resolving = undefined;
				}
			});
		entry.resolving = promise;
		return promise;
	}

	async function performAttempt(
		entry: Entry,
		source: ResolvedQuotaSource,
		controller: AbortController,
		attempt: Attempt,
	): Promise<QuotaRead> {
		let timeoutHandle: unknown;
		const timeout = new Promise<"timeout">((resolve) => {
			timeoutHandle = deps.setTimer(() => {
				controller.abort();
				resolve("timeout");
			}, QUOTA_REQUEST_TIMEOUT_MS);
		});
		const cancelTimeout = () => deps.clearTimer(timeoutHandle);
		controller.signal.addEventListener("abort", cancelTimeout, {
			once: true,
		});

		try {
			// The source may ignore abort; never wait past the timeout.
			const outcome = Promise.resolve()
				.then(() => source.read(controller.signal))
				.then(
					(value) => ({ kind: "read" as const, value }),
					() => ({ kind: "failed" as const }),
				);
			const result = await Promise.race([outcome, timeout]);

			if (result === "timeout") {
				if (disposed || entry.pending !== attempt) {
					return read(entry.providerID);
				}
				return commit(entry, timeoutRead(deps.now()));
			}

			// The coordinator issues every abort signal it owns. A transport
			// classifies our cancellation as `network_error`, so detect our own
			// abort BEFORE consulting any reason code and discard the attempt
			// without backoff or snapshot mutation.
			if (controller.signal.aborted || disposed || entry.pending !== attempt) {
				return read(entry.providerID);
			}

			if (result.kind === "failed") {
				return commit(entry, invalidResponseRead(deps.now()));
			}
			const value = result.value;
			if (!isQuotaRead(value)) {
				return commit(entry, invalidResponseRead(deps.now()));
			}

			let current = false;
			try {
				current = await source.isCurrent();
			} catch {
				current = false;
			}
			if (controller.signal.aborted || disposed || entry.pending !== attempt) {
				return read(entry.providerID);
			}

			if (
				!current &&
				(value.state === "available" || value.state === "partial")
			) {
				// A response from an obsolete registration/account/companion
				// cache must never be committed. The values already cached for
				// that identity are dropped too, so account A's figures cannot
				// linger after account B is selected.
				if (entry.identityKey === source.identityKey) {
					entry.snapshot = undefined;
					entry.autoRetry = false;
					notify(entry);
				}
				return read(entry.providerID);
			}

			// An explicit unavailable result is a failure observation, not stale
			// figures. Ollama's host-bridge failure source deliberately keeps the
			// success-path identityKey and reports `isCurrent() === false`; commit
			// the sanitized reason anyway so the user is not left with silence.
			return commit(entry, value);
		} finally {
			controller.signal.removeEventListener("abort", cancelTimeout);
			deps.clearTimer(timeoutHandle);
		}
	}

	async function refresh(providerID: string): Promise<QuotaRead> {
		if (disposed) {
			return read(providerID);
		}
		const entry = entryFor(providerID);
		const source = await resolveSource(entry);
		if (disposed) {
			return read(providerID);
		}
		if (source === undefined) {
			// Adapter/registry rejection is a sanitized observation; it must not
			// crash the watch loop.
			const value = commit(entry, invalidResponseRead(deps.now()));
			schedulePoll(entry);
			return value;
		}

		const identityChanged =
			entry.identityKey !== undefined &&
			entry.identityKey !== source.identityKey;
		entry.identityKey = source.identityKey;
		if (identityChanged) {
			// A new active account, registration, or companion cache owns the
			// provider now: the previous identity's snapshot is not current.
			entry.snapshot = undefined;
			entry.failures = 0;
			entry.cooldownUntil = undefined;
			entry.lastRequestAt = undefined;
			entry.autoRetry = false;
			notify(entry);
		}

		const pending = entry.pending;
		if (pending !== undefined) {
			if (pending.identityKey === source.identityKey) {
				schedulePoll(entry);
				return pending.promise;
			}
			// The identity changed while the old request was in flight. Abort it:
			// its response belongs to an account that is no longer selected.
			entry.pending = undefined;
			pending.controller.abort();
		}

		const now = deps.now();
		if (entry.cooldownUntil !== undefined && now < entry.cooldownUntil) {
			// A user refresh never bypasses an active provider cooldown.
			schedulePoll(entry);
			return read(providerID);
		}
		if (
			entry.lastRequestAt !== undefined &&
			now - entry.lastRequestAt < QUOTA_MANUAL_FLOOR_MS
		) {
			schedulePoll(entry);
			return read(providerID);
		}

		entry.lastRequestAt = now;
		const controller = new AbortController();
		const attempt: Attempt = {
			identityKey: source.identityKey,
			controller,
			promise: Promise.resolve(emptyRead(now)),
		};
		entry.pending = attempt;
		attempt.promise = performAttempt(
			entry,
			source,
			controller,
			attempt,
		).finally(() => {
			if (entry.pending === attempt) {
				entry.pending = undefined;
			}
			schedulePoll(entry);
		});
		return attempt.promise;
	}

	function watch(
		providerID: string,
		listener: (value: QuotaRead) => void,
	): () => void {
		if (disposed) {
			return () => {};
		}
		const entry = entryFor(providerID);
		entry.listeners.add(listener);
		if (entry.snapshot !== undefined) {
			try {
				listener(read(providerID));
			} catch {
				// Registration always succeeds even if the first delivery fails.
			}
		}
		if (entry.listeners.size === 1) {
			// Visibility starts the lifecycle: one request, then polling while
			// at least one consumer remains subscribed.
			void refresh(providerID);
		} else {
			schedulePoll(entry);
		}
		return () => {
			if (!entry.listeners.delete(listener)) {
				return;
			}
			if (entry.listeners.size === 0) {
				clearPoll(entry);
			}
		};
	}

	function invalidate(identityKey: string): void {
		for (const entry of entries.values()) {
			if (entry.identityKey !== identityKey) {
				continue;
			}
			entry.pending?.controller.abort();
			entry.pending = undefined;
			entry.snapshot = undefined;
			entry.failures = 0;
			entry.cooldownUntil = undefined;
			entry.lastRequestAt = undefined;
			entry.autoRetry = false;
			notify(entry);
		}
	}

	function dispose(): void {
		disposed = true;
		for (const entry of entries.values()) {
			clearPoll(entry);
			entry.pending?.controller.abort();
			entry.pending = undefined;
			entry.resolveController?.abort();
			entry.resolving = undefined;
			entry.listeners.clear();
		}
		entries.clear();
	}

	return { watch, read, refresh, invalidate, dispose };
}
