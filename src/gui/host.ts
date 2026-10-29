import type { ClaudeUsage } from "../claude-code/usage";
import type {
	QuotaGetResult,
	QuotaListResult,
	QuotaProviderRef,
	QuotaUpdatedEvent,
} from "../rpc";

export type Unsubscribe = () => void;

export type HostActivity =
	| {
			kind: "step-started" | "step-finished" | "step-failed";
			providerID: string;
	  }
	| { kind: "input" | "focus" }; // state-changing, owning window only

export type UsageRpc = {
	list(signal: AbortSignal): Promise<QuotaListResult>;
	get(ref: QuotaProviderRef, signal: AbortSignal): Promise<QuotaGetResult>;
	refresh(ref: QuotaProviderRef, signal: AbortSignal): Promise<QuotaGetResult>;
	/** null on every non-abort failure incl. rpc.method_not_found; rejects only with AbortError. */
	claudeCodeUsage(signal: AbortSignal): Promise<ClaudeUsage | null>;
	onUpdated(handler: (event: QuotaUpdatedEvent) => void): Unsubscribe;
};

export type SessionHost = {
	sessionID: string;
	selectedProviderID(): string | undefined;
	onSelectedModel(handler: () => void): Unsubscribe;
	visible(): boolean;
	onVisible(handler: (visible: boolean) => void): Unsubscribe;
	/** The binding delivers only events of the owning session; the controller never filters by session. */
	onActivity(handler: (event: HostActivity) => void): Unsubscribe;
};
