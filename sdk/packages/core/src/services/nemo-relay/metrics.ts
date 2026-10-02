import type { AgentUsage, ProviderErrorClass } from "@cline/shared";
import { DefaultToolNames } from "../../extensions/tools/constants";
import type {
	NemoRelayRunContext,
	RelayJson,
	RelayMeasurement,
	RelayModule,
	RelayScopeHandle,
} from "./contracts";
import type { ObservationOmissionReason } from "./projection";

type ModelOutcome =
	| "completed"
	| "aborted"
	| "failed"
	| "filtered"
	| "interrupted"
	| "limited";
type RunOutcome = "completed" | "aborted" | "limited" | "failed";

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

const TOKEN_USAGE_FIELDS = [
	["input", "inputTokens"],
	["output", "outputTokens"],
	["cache_read", "cacheReadTokens"],
	["cache_write", "cacheWriteTokens"],
	["reasoning", "reasoningTokenCount"],
] as const;

type TokenType = (typeof TOKEN_USAGE_FIELDS)[number][0];

export class RunMetrics {
	private activeTools = 0;
	private peakActiveTools = 0;
	private modelCalls = 0;
	private skillToolCalls = 0;
	private toolExecutions = 0;
	private toolCallbackFailures = 0;
	private readonly runTokens: Partial<Record<TokenType, number>> = {};
	private readonly invalidRunTokenTypes = new Set<TokenType>();
	private runCost = 0;
	private hasRunCost = false;
	private runCostInvalid = false;
	private runActive = false;

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
		this.modelCalls += 1;
		this.accumulateRunUsage(input.usage);
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
		for (const [tokenType, field] of TOKEN_USAGE_FIELDS) {
			const value = input.usage?.[field];
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

	toolStarted(): void {
		this.activeTools += 1;
		this.toolExecutions += 1;
		this.peakActiveTools = Math.max(this.peakActiveTools, this.activeTools);
		this.emit("cline.agent.tool.active", [
			upDown("cline.agent.active_tools", 1),
		]);
	}

	toolCompleted(
		toolName: string,
		callbackOutcome: "returned" | "threw",
		durationMs: number,
	): void {
		this.activeTools = Math.max(0, this.activeTools - 1);
		if (toolName === DefaultToolNames.SKILLS) this.skillToolCalls += 1;
		if (callbackOutcome === "threw") this.toolCallbackFailures += 1;
		this.emit("cline.agent.tool.active", [
			upDown("cline.agent.active_tools", -1),
		]);
		this.emit(
			"cline.agent.tool.completed",
			[
				counter("cline.agent.tool.executions"),
				seconds("cline.agent.tool.duration", durationMs),
			],
			{ callback_outcome: callbackOutcome },
		);
	}

	runStarted(): void {
		if (this.runActive) return;
		this.runActive = true;
		this.emit("cline.agent.run.active", [upDown("cline.agent.active_runs", 1)]);
	}

	omission(
		operation: "model" | "tool",
		reason: ObservationOmissionReason,
	): void {
		this.emit(
			"cline.agent.observation.omitted",
			[counter("cline.agent.observation.omissions")],
			{ operation, reason },
		);
	}

	runCompleted(input: {
		outcome: RunOutcome;
		durationMs: number;
		iterations?: number;
	}): void {
		if (this.runActive) {
			this.runActive = false;
			this.emit("cline.agent.run.active", [
				upDown("cline.agent.active_runs", -1),
			]);
		}
		const metrics: MetricSpec[] = [
			counter("cline.agent.runs"),
			seconds("cline.agent.run.duration", input.durationMs),
			integerHistogram("cline.agent.run.model_calls", this.modelCalls),
			integerHistogram(
				"cline.agent.run.peak_active_tools",
				this.peakActiveTools,
			),
			integerHistogram(
				"cline.agent.run.skills_tool_calls",
				this.skillToolCalls,
			),
			integerHistogram("cline.agent.run.tool_executions", this.toolExecutions),
			integerHistogram(
				"cline.agent.run.tool_callback_failures",
				this.toolCallbackFailures,
			),
		];
		for (const [tokenType] of TOKEN_USAGE_FIELDS) {
			const value = this.runTokens[tokenType];
			if (value !== undefined) {
				metrics.push(
					integerHistogram("cline.agent.run.tokens", value, "{token}", {
						token_type: tokenType,
					}),
				);
			}
		}
		if (this.hasRunCost && !this.runCostInvalid) {
			metrics.push({
				name: "cline.agent.run.cost",
				kind: "Histogram",
				valueType: "F64",
				value: this.runCost,
				unit: "USD",
			});
		}
		if (isNonNegativeSafeInteger(input.iterations)) {
			metrics.push(
				integerHistogram("cline.agent.run.iterations", input.iterations),
			);
		}
		this.emit("cline.agent.run.completed", metrics, {
			outcome: input.outcome,
			invoked_skills_tool: this.skillToolCalls > 0,
		});
	}

	private accumulateRunUsage(usage: Partial<AgentUsage> | undefined): void {
		for (const [tokenType, field] of TOKEN_USAGE_FIELDS) {
			const value = usage?.[field];
			if (
				!isNonNegativeSafeInteger(value) ||
				this.invalidRunTokenTypes.has(tokenType)
			) {
				continue;
			}
			const total = (this.runTokens[tokenType] ?? 0) + value;
			if (Number.isSafeInteger(total)) {
				this.runTokens[tokenType] = total;
			} else {
				delete this.runTokens[tokenType];
				this.invalidRunTokenTypes.add(tokenType);
			}
		}

		const cost = usage?.totalCost;
		if (
			!this.runCostInvalid &&
			typeof cost === "number" &&
			Number.isFinite(cost) &&
			cost >= 0
		) {
			this.hasRunCost = true;
			this.runCost += cost;
			if (!Number.isFinite(this.runCost)) this.runCostInvalid = true;
		}
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

function integerHistogram(
	name: string,
	value: number,
	unit?: string,
	attributes?: Record<string, RelayJson>,
): MetricSpec {
	return { name, kind: "Histogram", valueType: "U64", value, unit, attributes };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return isNonNegativeSafeInteger(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
