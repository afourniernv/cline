import type { AgentUsage, ProviderErrorClass } from "@cline/shared";
import type {
	NemoRelayRunContext,
	RelayJson,
	RelayMeasurement,
	RelayModule,
	RelayScopeHandle,
} from "./contracts";

type ModelOutcome =
	| "completed"
	| "aborted"
	| "failed"
	| "filtered"
	| "interrupted"
	| "limited";

interface ModelMetricInput {
	outcome: ModelOutcome;
	durationMs: number;
	timeToFirstEventMs?: number;
	usage?: Partial<AgentUsage>;
	toolCallCount: number;
	errorClass?: ProviderErrorClass;
	errorRetryable?: boolean;
}

interface MetricSpec {
	name: string;
	kind: keyof RelayModule["MetricKind"];
	valueType: keyof RelayModule["MetricValueType"];
	value: number;
	unit?: string;
	attributes?: Record<string, RelayJson>;
}

export class RunMetrics {
	constructor(
		private readonly relay: RelayModule,
		private readonly parent: RelayScopeHandle,
		private readonly context: NemoRelayRunContext,
		private readonly onFailure: (error: unknown) => void,
	) {}

	modelStarted(): void {
		this.emit("cline.agent.model.active", [
			upDown("cline.agent.active_model_calls", 1),
		]);
	}

	modelCompleted(input: ModelMetricInput): void {
		this.emit("cline.agent.model.active", [
			upDown("cline.agent.active_model_calls", -1),
		]);
		const attributes = {
			outcome: input.outcome,
			...(input.errorClass ? { error_class: input.errorClass } : {}),
			...(input.errorRetryable === undefined
				? {}
				: { error_retryable: input.errorRetryable }),
		};
		const metrics: MetricSpec[] = [
			counter("cline.agent.model.calls"),
			seconds("cline.agent.model.duration", input.durationMs),
		];
		if (isNonNegativeFinite(input.timeToFirstEventMs)) {
			metrics.push(
				seconds(
					"cline.agent.model.time_to_first_event",
					input.timeToFirstEventMs,
				),
			);
		}
		for (const [tokenType, value] of [
			["input", input.usage?.inputTokens],
			["output", input.usage?.outputTokens],
			["cache_read", input.usage?.cacheReadTokens],
			["cache_write", input.usage?.cacheWriteTokens],
			["reasoning", input.usage?.reasoningTokenCount],
		] as const) {
			if (isPositiveSafeInteger(value)) {
				metrics.push(
					counter("cline.agent.model.tokens", value, "{token}", {
						token_type: tokenType,
					}),
				);
			}
		}
		const cost = input.usage?.totalCost;
		if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
			metrics.push({
				name: "cline.agent.model.cost",
				kind: "Counter",
				valueType: "F64",
				value: cost,
				unit: "USD",
			});
		}
		if (isPositiveSafeInteger(input.toolCallCount)) {
			metrics.push(
				counter("cline.agent.model.tool_calls", input.toolCallCount),
			);
		}
		this.emit("cline.agent.model.completed", metrics, attributes);
	}

	private emit(
		name: string,
		metrics: MetricSpec[],
		attributes: Record<string, RelayJson> = {},
	): void {
		try {
			const measurements: RelayMeasurement[] = metrics.map(
				({ kind, valueType, attributes: extra, ...measurement }) => ({
					...measurement,
					kind: this.relay.MetricKind[kind],
					valueType: this.relay.MetricValueType[valueType],
					attributes: {
						surface: this.context.surface,
						mode: this.context.mode,
						agent_kind: this.context.isSubagent ? "subagent" : "root",
						...attributes,
						...extra,
					},
				}),
			);
			this.relay.metric(name, measurements, this.parent);
		} catch (error) {
			this.onFailure(error);
		}
	}
}

function counter(
	name: string,
	value = 1,
	unit?: string,
	attributes?: Record<string, RelayJson>,
): MetricSpec {
	return { name, kind: "Counter", valueType: "U64", value, unit, attributes };
}

function seconds(name: string, durationMs: number): MetricSpec {
	return {
		name,
		kind: "Histogram",
		valueType: "F64",
		value: Math.max(0, durationMs) / 1_000,
		unit: "s",
	};
}

function upDown(name: string, value: 1 | -1): MetricSpec {
	return { name, kind: "UpDownCounter", valueType: "I64", value };
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
