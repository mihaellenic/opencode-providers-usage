import {
	type CoordinatorDeps,
	isQuotaPresentation,
	isQuotaRead,
	type QuotaCoordinator,
	type QuotaPresentation,
	type QuotaRead,
	type QuotaSectionsRead,
	type ResolvedQuotaSource,
	type SectionResult,
} from "./contracts";

/** Legacy name for the recovery retry interval. */
export const QUOTA_POLL_MS = 60_000;
/** Retry spacing while a failure episode is younger than the grace period. */
export const QUOTA_RECOVERY_INTERVAL_MS = 60_000;
/** After this much elapsed failure time, the capped backoff takes over. */
export const QUOTA_RECOVERY_GRACE_MS = 180_000;
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
	/** Bumped on every identity invalidation so stale resolutions bail out. */
	generation: number;
	snapshot?: QuotaRead;
	/** Last complete, fully available observation from the current identity. */
	lastKnown?: QuotaSectionsRead;
	/** Coordinator runtime-wide mutation revision last applied to this entry. */
	revision: number;
	/** Start of the active retryable failure episode, at completion time. */
	failedSince?: number;
	/** Consecutive retryable failures, for the capped backoff. */
	failures: number;
	/** True only while a retryable failure episode is active. */
	recovering: boolean;
	/** Start of the most recent request; drives the manual floor. */
	lastRequestAt?: number;
	/** The next automatic request may not start before this instant. */
	cooldownUntil?: number;
	nextRetryAt?: number;
	/** In-flight attempt shared by every consumer of this provider. */
	pending?: Attempt;
	resolving?: Promise<ResolvedQuotaSource | undefined>;
	resolveController?: AbortController;
	timer?: unknown;
};

function hasSections(read: QuotaRead): read is QuotaSectionsRead {
	return "sections" in read;
}

function isCompleteRead(read: QuotaRead): read is QuotaSectionsRead {
	return (
		hasSections(read) &&
		read.state === "available" &&
		read.sections.every((section) => section.result.state === "available")
	);
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

function sectionRetryAfter(read: QuotaSectionsRead): number | undefined {
	let retryAfterMs: number | undefined;
	for (const section of read.sections) {
		if (section.result.state === "available") {
			continue;
		}
		const hint = section.result.retryAfterMs;
		if (
			hint !== undefined &&
			(retryAfterMs === undefined || hint > retryAfterMs)
		) {
			retryAfterMs = hint;
		}
	}
	return retryAfterMs;
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
 * recovery timers and the one in-flight request per provider. Two views of the
 * same provider therefore share a single request.
 *
 * Successful reads are idle: they schedule no network timer. Only a retryable
 * failure episode schedules work, and those retries are server-owned, so they
 * survive with no presentation listeners. Dispose and identity invalidation
 * cancel the owned timers and attempts.
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
	/** Runtime-wide monotonic counter; entries keep their last applied value. */
	let revisionCounter = 0;

	function entryFor(providerID: string): Entry {
		let entry = entries.get(providerID);
		if (entry === undefined) {
			entry = {
				providerID,
				listeners: new Set(),
				generation: 0,
				revision: 0,
				failures: 0,
				recovering: false,
			};
			entries.set(providerID, entry);
		}
		return entry;
	}

	function bumpRevision(entry: Entry): void {
		revisionCounter += 1;
		entry.revision = revisionCounter;
	}

	function read(providerID: string): QuotaRead {
		const entry = entries.get(providerID);
		if (entry?.snapshot === undefined) {
			return emptyRead(deps.now());
		}
		return currentView(entry.snapshot, deps.now());
	}

	function presentation(providerID: string): QuotaPresentation {
		const entry = entries.get(providerID);
		if (entry === undefined) {
			return { revision: 0 };
		}
		const value: QuotaPresentation = {
			revision: entry.revision,
			...(entry.lastKnown === undefined ? {} : { lastKnown: entry.lastKnown }),
			...(entry.failedSince === undefined
				? {}
				: { failedSince: entry.failedSince }),
		};
		// History is only exposed when it is a complete available observation.
		// An inconsistent internal value is dropped rather than crossing the
		// public boundary.
		return isQuotaPresentation(value) ? value : { revision: entry.revision };
	}

	function isRecovering(providerID: string): boolean {
		return entries.get(providerID)?.recovering === true;
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

	function clearTimer(entry: Entry): void {
		if (entry.timer !== undefined) {
			deps.clearTimer(entry.timer);
			entry.timer = undefined;
		}
	}

	/**
	 * Clears historical presentation and the recovery episode while leaving the
	 * current observation (the snapshot) intact for failure-state display.
	 */
	function clearHistory(entry: Entry): void {
		entry.lastKnown = undefined;
		entry.failedSince = undefined;
		entry.failures = 0;
		entry.recovering = false;
		entry.cooldownUntil = undefined;
		entry.nextRetryAt = undefined;
		clearTimer(entry);
	}

	function startFailure(entry: Entry, completedAt: number): void {
		if (entry.failedSince === undefined) {
			entry.failedSince = completedAt;
		}
		entry.failures += 1;
		entry.recovering = true;
	}

	function armRecoveryTimer(entry: Entry): void {
		if (
			disposed ||
			!entry.recovering ||
			entry.timer !== undefined ||
			entry.nextRetryAt === undefined
		) {
			return;
		}
		const wait = Math.max(0, entry.nextRetryAt - deps.now());
		entry.timer = deps.setTimer(() => {
			entry.timer = undefined;
			void refresh(entry.providerID);
		}, wait);
	}

	/**
	 * Schedules the next server-owned retry. The first three minutes of an
	 * episode retry at the recovery interval; after that the capped backoff
	 * applies. Retry-After is always a lower bound, and the request-start floor
	 * is respected in every path.
	 */
	function scheduleRecovery(
		entry: Entry,
		completedAt: number,
		retryAfterMs: number | undefined,
	): void {
		clearTimer(entry);
		if (disposed || !entry.recovering || entry.failedSince === undefined) {
			entry.nextRetryAt = undefined;
			return;
		}

		const elapsed = Math.max(0, completedAt - entry.failedSince);
		const backoffIndex = Math.min(
			Math.max(entry.failures - 1, 0),
			QUOTA_BACKOFF_MS.length - 1,
		);
		const base =
			elapsed < QUOTA_RECOVERY_GRACE_MS
				? QUOTA_RECOVERY_INTERVAL_MS
				: (QUOTA_BACKOFF_MS[backoffIndex] ?? 300_000);
		const delay = Math.max(base, retryAfterMs ?? 0);

		let due = completedAt + delay;
		if (entry.lastRequestAt !== undefined) {
			due = Math.max(due, entry.lastRequestAt + QUOTA_MANUAL_FLOOR_MS);
		}
		if (entry.cooldownUntil !== undefined) {
			due = Math.max(due, entry.cooldownUntil);
		}
		entry.cooldownUntil = due;
		entry.nextRetryAt = due;
		entry.timer = deps.setTimer(
			() => {
				entry.timer = undefined;
				void refresh(entry.providerID);
			},
			Math.max(0, due - deps.now()),
		);
	}

	function commit(entry: Entry, value: QuotaRead): QuotaRead {
		const completedAt = deps.now();
		entry.snapshot = value;
		bumpRevision(entry);

		if (hasSections(value)) {
			if (isCompleteRead(value)) {
				// Full success is the only path that creates history or ends a
				// recovery episode.
				entry.lastKnown = value;
				entry.failedSince = undefined;
				entry.failures = 0;
				entry.recovering = false;
				entry.cooldownUntil = undefined;
				entry.nextRetryAt = undefined;
				clearTimer(entry);
			} else {
				// A partial result starts or continues failure timing; it never
				// replaces the last complete history.
				startFailure(entry, completedAt);
				scheduleRecovery(entry, completedAt, sectionRetryAfter(value));
			}
		} else if (value.state === "auth-required") {
			// Rejected credentials invalidate the old identity's figures.
			clearHistory(entry);
		} else if (NO_AUTO_RETRY.has(value.reason)) {
			clearHistory(entry);
		} else {
			startFailure(entry, completedAt);
			scheduleRecovery(entry, completedAt, value.retryAfterMs);
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

			if (!current && hasSections(value)) {
				// A response from an obsolete registration/account/companion
				// cache must never be committed, and the figures already cached
				// for that identity are dropped with it. History is cleared too:
				// a rejected currentness check is an identity-integrity failure,
				// not a transient provider failure.
				entry.snapshot = undefined;
				clearHistory(entry);
				bumpRevision(entry);
				notify(entry);
				return read(entry.providerID);
			}

			// An explicit unavailable result is a failure observation, not stale
			// figures. Ollama's host-bridge failure source reports
			// `isCurrent() === false` alongside a sanitized unavailable read;
			// commit that reason anyway so the user is not left with silence.
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
		const generation = entry.generation;
		const source = await resolveSource(entry);
		if (disposed) {
			return read(providerID);
		}
		if (entry.generation !== generation) {
			// An invalidation landed while the source was resolving; its result
			// belongs to the discarded identity.
			return read(providerID);
		}
		if (source === undefined) {
			// Adapter/registry rejection is a sanitized observation; it must not
			// crash the watch loop.
			return commit(entry, invalidResponseRead(deps.now()));
		}

		const identityChanged =
			entry.identityKey !== undefined &&
			entry.identityKey !== source.identityKey;
		entry.identityKey = source.identityKey;
		if (identityChanged) {
			// A new active account, registration, or companion cache owns the
			// provider now: the previous identity's snapshot and history are not
			// current. In-flight resolutions and attempts from the old identity
			// are abandoned.
			entry.generation += 1;
			entry.snapshot = undefined;
			entry.lastRequestAt = undefined;
			clearHistory(entry);
			bumpRevision(entry);
			notify(entry);
		}

		const pending = entry.pending;
		if (pending !== undefined) {
			if (pending.identityKey === source.identityKey) {
				return pending.promise;
			}
			// The identity changed while the old request was in flight. Abort it:
			// its response belongs to an account that is no longer selected.
			entry.pending = undefined;
			pending.controller.abort();
		}

		const now = deps.now();
		if (entry.cooldownUntil !== undefined && now < entry.cooldownUntil) {
			// A user refresh never bypasses an active provider cooldown or the
			// scheduled recovery instant.
			armRecoveryTimer(entry);
			return read(providerID);
		}
		if (
			entry.lastRequestAt !== undefined &&
			now - entry.lastRequestAt < QUOTA_MANUAL_FLOOR_MS
		) {
			armRecoveryTimer(entry);
			return read(providerID);
		}

		clearTimer(entry);
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
			// Visibility starts the lifecycle: one request. Success is idle;
			// only a retryable failure schedules follow-up work.
			void refresh(providerID);
		}
		return () => {
			if (!entry.listeners.delete(listener)) {
				return;
			}
			// Server-owned recovery retries survive zero presentation listeners.
			// Dispose and identity invalidation are the cancellation paths.
		};
	}

	function invalidate(identityKey: string): void {
		for (const entry of entries.values()) {
			if (entry.identityKey !== identityKey) {
				continue;
			}
			entry.generation += 1;
			entry.pending?.controller.abort();
			entry.pending = undefined;
			entry.resolveController?.abort();
			entry.resolveController = undefined;
			entry.resolving = undefined;
			entry.snapshot = undefined;
			entry.lastRequestAt = undefined;
			clearHistory(entry);
			bumpRevision(entry);
			notify(entry);
		}
	}

	function dispose(): void {
		disposed = true;
		for (const entry of entries.values()) {
			clearTimer(entry);
			entry.pending?.controller.abort();
			entry.pending = undefined;
			entry.resolveController?.abort();
			entry.resolving = undefined;
			entry.listeners.clear();
		}
		entries.clear();
	}

	return {
		watch,
		read,
		refresh,
		presentation,
		isRecovering,
		invalidate,
		dispose,
	};
}
