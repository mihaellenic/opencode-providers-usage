import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { UsageController } from "./state";

/**
 * Bridges the framework-free controller into Solid. Reading the returned
 * accessor inside a computation re-runs it after every controller change;
 * the subscription ends with the owning scope.
 */
export function useController(controller: UsageController): Accessor<number> {
	const [version, setVersion] = createSignal(0);
	const unsubscribe = controller.subscribe(() => setVersion((n) => n + 1));
	onCleanup(unsubscribe);
	return version;
}

const summaryButtons = new WeakMap<UsageController, HTMLElement>();
const pendingFocus = new WeakSet<UsageController>();

/** Registers the live summary button so Back can hand focus to it. */
export function registerSummaryButton(
	controller: UsageController,
	element: HTMLElement,
): void {
	summaryButtons.set(controller, element);
	if (pendingFocus.delete(controller)) element.focus();
}

export function unregisterSummaryButton(
	controller: UsageController,
	element: HTMLElement,
): void {
	if (summaryButtons.get(controller) === element)
		summaryButtons.delete(controller);
}

/**
 * Focus the summary button now, or as soon as it mounts when the host swaps
 * views by unmounting one of them.
 */
export function focusSummary(controller: UsageController): void {
	const element = summaryButtons.get(controller);
	if (element === undefined) pendingFocus.add(controller);
	else element.focus();
}
