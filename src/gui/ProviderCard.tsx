import { For, type JSX, Show } from "solid-js";
import type {
	SidebarCell,
	SidebarLine,
	SidebarTone,
} from "../ui/sidebar-model";
import type { UsagePageCard } from "../ui/usage-page-model";

function Cell(props: { cell: SidebarCell; class: string }): JSX.Element {
	return (
		<span class={props.class} data-tone={props.cell.tone}>
			{props.cell.text}
		</span>
	);
}

/** Percent with at most one decimal, the precision the visible text carries. */
function percentNow(fill: number): number {
	return Math.round(Math.min(1, Math.max(0, fill)) * 1000) / 10;
}

function Bar(props: {
	fill: number;
	label: string;
	valueText: string;
	tone: SidebarTone;
}): JSX.Element {
	return (
		<span
			class="ou-bar"
			role="progressbar"
			aria-label={props.label}
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={percentNow(props.fill)}
			aria-valuetext={props.valueText}
			data-tone={props.tone}
		>
			<span
				class="ou-bar-fill"
				style={{ width: `${percentNow(props.fill)}%` }}
			/>
		</span>
	);
}

function lineBody(line: SidebarLine, subject: string): JSX.Element {
	switch (line.kind) {
		case "window":
			return (
				<>
					<span class="ou-label">{line.label}</span>
					{line.fill === undefined ? null : (
						<Bar
							fill={line.fill}
							label={`${subject} ${line.label} used`}
							valueText={line.value.text}
							tone={line.value.tone}
						/>
					)}
					<Cell class="ou-value" cell={line.value} />
					{line.reset === undefined ? null : (
						<span class="ou-reset">{line.reset}</span>
					)}
				</>
			);
		case "bar":
			return (
				<>
					<Bar
						fill={line.fill}
						label={`${subject} used`}
						valueText={line.percent.text}
						tone={line.percent.tone}
					/>
					<Cell class="ou-value" cell={line.percent} />
					{line.reset === undefined ? null : (
						<span class="ou-reset">{line.reset}</span>
					)}
				</>
			);
		case "credit":
			return (
				<>
					<span class="ou-label">{line.label}</span>
					<Cell class="ou-value" cell={line.value} />
					{line.detail === undefined ? null : (
						<span class="ou-detail">{line.detail}</span>
					)}
				</>
			);
		case "pair":
			return (
				<>
					<Cell class="ou-value" cell={line.left} />
					{line.right === undefined ? null : (
						<Cell class="ou-value" cell={line.right} />
					)}
				</>
			);
		case "status":
			return (
				<span class="ou-value" data-tone={line.tone}>
					{line.text}
				</span>
			);
	}
}

function Line(props: { line: SidebarLine; subject: string }): JSX.Element {
	return (
		<div class="ou-line" data-line={props.line.kind}>
			{lineBody(props.line, props.subject)}
		</div>
	);
}

export type ProviderCardProps = {
	card: UsagePageCard;
	error?: string | undefined;
	onRetry?: (() => void) | undefined;
};

export function ProviderCard(props: ProviderCardProps): JSX.Element {
	return (
		<article class="ou-card" data-provider={props.card.id}>
			<h3 class="ou-card-name">{props.card.name}</h3>
			<UsageLines lines={props.card.lines} subject={props.card.name} />
			<Show when={props.error}>
				{(message) => (
					<p class="ou-error" role="alert" data-tone="error">
						<span>{message()}</span>
						<Show when={props.onRetry}>
							{(retry) => (
								<button
									class="ou-button"
									type="button"
									onClick={() => retry()()}
								>
									Retry
								</button>
							)}
						</Show>
					</p>
				)}
			</Show>
		</article>
	);
}

export function UsageLines(props: {
	lines: SidebarLine[];
	subject: string;
}): JSX.Element {
	return (
		<For each={props.lines}>
			{(line) => <Line line={line} subject={props.subject} />}
		</For>
	);
}
