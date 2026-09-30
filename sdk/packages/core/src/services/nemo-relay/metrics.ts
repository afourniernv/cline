import type { AgentUsage } from "@cline/shared";
import {
	type NemoRelayRunContext,
	type RelayMeasurement,
	type RelayModule,
	type RelayScopeHandle,
	relayRuntimeEnums,
} from "./contracts";

type RunOutcome = "completed" | "aborted" | "limited" | "failed";
type ToolOutcome = "completed" | "failed";

interface ModelMetricInput {
	outcome: string;
	durationMs: number;
	usage?: Partial<AgentUsage>;
	toolCallCount: number;
	errorClass?: string;
	errorRetryable?: boolean;
}

interface RunMetricInput {
	outcome: RunOutcome;
	durationMs: number;
	iterations?: number;
}

type MetricFailureHandler = (error: unknown) => void;

/**
 * Owns Cline's bounded custom Relay metrics for one observed run.
 *
 * Keeping the counters and their run-local aggregation together makes it hard
 * for trace projection changes to accidentally introduce new metric labels.
 */
export class RunMetrics {
	private activeTools = 0;
	private peakActiveTools = 0;
	private modelAttempts = 0;
	private skillsToolCalls = 0;

	constructor(
		private readonly relay: RelayModule,
		private readonly parent: RelayScopeHandle,
		private readonly context: NemoRelayRunContext,
		private readonly onFailure: MetricFailureHandler,
	) {}

	modelCompleted(input: ModelMetricInput): void {
		this.guard(() => this.recordModelCompleted(input));
	}

	private recordModelCompleted(input: ModelMetricInput): void {
		this.modelAttempts += 1;
		const enums = relayRuntimeEnums(this.relay);
		const attributes = {
			...this.baseAttributes(),
			outcome: input.outcome,
			...(input.errorClass ? { error_class: input.errorClass } : {}),
			...(input.errorRetryable === undefined
				? {}
				: { error_retryable: input.errorRetryable }),
		};
		const measurements: RelayMeasurement[] = [
			{
				name: "cline.agent.model.calls",
				kind: enums.MetricKind.Counter,
				valueType: enums.MetricValueType.U64,
				value: 1,
				attributes,
			},
			{
				name: "cline.agent.model.duration",
				kind: enums.MetricKind.Histogram,
				valueType: enums.MetricValueType.F64,
				value: Math.max(0, input.durationMs) / 1_000,
				unit: "s",
				attributes,
			},
		];

		for (const [tokenType, value] of [
			["input", input.usage?.inputTokens],
			["output", input.usage?.outputTokens],
			["cache_read", input.usage?.cacheReadTokens],
			["cache_write", input.usage?.cacheWriteTokens],
			["reasoning", input.usage?.reasoningTokenCount],
		] as const) {
			if (!isPositiveSafeInteger(value)) continue;
			measurements.push({
				name: "cline.agent.model.tokens",
				kind: enums.MetricKind.Counter,
				valueType: enums.MetricValueType.U64,
				value,
				unit: "{token}",
				attributes: { ...attributes, token_type: tokenType },
			});
		}

		const totalCost = input.usage?.totalCost;
		if (
			typeof totalCost === "number" &&
			Number.isFinite(totalCost) &&
			totalCost > 0
		) {
			measurements.push({
				name: "cline.agent.model.cost",
				kind: enums.MetricKind.Counter,
				valueType: enums.MetricValueType.F64,
				value: totalCost,
				unit: "USD",
				attributes,
			});
		}

		if (isPositiveSafeInteger(input.toolCallCount)) {
			measurements.push({
				name: "cline.agent.model.tool_calls",
				kind: enums.MetricKind.Counter,
				valueType: enums.MetricValueType.U64,
				value: input.toolCallCount,
				attributes,
			});
		}

		this.emit("cline.agent.model.completed", measurements);
	}

	toolStarted(): void {
		this.guard(() => this.recordToolStarted());
	}

	private recordToolStarted(): void {
		this.activeTools += 1;
		this.peakActiveTools = Math.max(this.peakActiveTools, this.activeTools);
		this.emitActiveTools(1);
	}

	toolCompleted(
		toolName: string,
		outcome: ToolOutcome,
		durationMs: number,
	): void {
		this.guard(() => this.recordToolCompleted(toolName, outcome, durationMs));
	}

	private recordToolCompleted(
		toolName: string,
		outcome: ToolOutcome,
		durationMs: number,
	): void {
		this.activeTools = Math.max(0, this.activeTools - 1);
		this.emitActiveTools(-1);
		if (toolName === "skills") this.skillsToolCalls += 1;

		const enums = relayRuntimeEnums(this.relay);
		const attributes = {
			...this.baseAttributes(),
			outcome,
		};
		this.emit("cline.agent.tool.completed", [
			{
				name: "cline.agent.tool.executions",
				kind: enums.MetricKind.Counter,
				valueType: enums.MetricValueType.U64,
				value: 1,
				attributes,
			},
			{
				name: "cline.agent.tool.duration",
				kind: enums.MetricKind.Histogram,
				valueType: enums.MetricValueType.F64,
				value: Math.max(0, durationMs) / 1_000,
				unit: "s",
				attributes,
			},
		]);
	}

	omission(operation: "model" | "tool", reason: string): void {
		this.guard(() => this.recordOmission(operation, reason));
	}

	private recordOmission(operation: "model" | "tool", reason: string): void {
		const enums = relayRuntimeEnums(this.relay);
		this.emit("cline.agent.observation.omitted", [
			{
				name: "cline.agent.observation.omissions",
				kind: enums.MetricKind.Counter,
				valueType: enums.MetricValueType.U64,
				value: 1,
				attributes: { ...this.baseAttributes(), operation, reason },
			},
		]);
	}

	runCompleted(input: RunMetricInput): void {
		this.guard(() => this.recordRunCompleted(input));
	}

	private recordRunCompleted(input: RunMetricInput): void {
		const enums = relayRuntimeEnums(this.relay);
		const attributes = {
			...this.baseAttributes(),
			outcome: input.outcome,
			used_skills_tool: this.skillsToolCalls > 0,
		};
		const measurements: RelayMeasurement[] = [
			{
				name: "cline.agent.runs",
				kind: enums.MetricKind.Counter,
				valueType: enums.MetricValueType.U64,
				value: 1,
				attributes,
			},
			{
				name: "cline.agent.run.duration",
				kind: enums.MetricKind.Histogram,
				valueType: enums.MetricValueType.F64,
				value: Math.max(0, input.durationMs) / 1_000,
				unit: "s",
				attributes,
			},
			{
				name: "cline.agent.run.model_attempts",
				kind: enums.MetricKind.Histogram,
				valueType: enums.MetricValueType.U64,
				value: this.modelAttempts,
				attributes,
			},
			{
				name: "cline.agent.run.peak_active_tools",
				kind: enums.MetricKind.Histogram,
				valueType: enums.MetricValueType.U64,
				value: this.peakActiveTools,
				attributes,
			},
			{
				name: "cline.agent.run.skills_tool_calls",
				kind: enums.MetricKind.Histogram,
				valueType: enums.MetricValueType.U64,
				value: this.skillsToolCalls,
				attributes,
			},
		];
		if (isNonNegativeSafeInteger(input.iterations)) {
			measurements.push({
				name: "cline.agent.run.iterations",
				kind: enums.MetricKind.Histogram,
				valueType: enums.MetricValueType.U64,
				value: input.iterations,
				attributes,
			});
		}
		this.emit("cline.agent.run.completed", measurements);
	}

	private emitActiveTools(value: 1 | -1): void {
		const enums = relayRuntimeEnums(this.relay);
		this.emit("cline.agent.tool.active", [
			{
				name: "cline.agent.active_tools",
				kind: enums.MetricKind.UpDownCounter,
				valueType: enums.MetricValueType.I64,
				value,
				attributes: this.baseAttributes(),
			},
		]);
	}

	private baseAttributes(): {
		surface: NemoRelayRunContext["surface"];
		mode: NemoRelayRunContext["mode"];
		agent_kind: "root" | "subagent";
	} {
		return {
			surface: this.context.surface,
			mode: this.context.mode,
			agent_kind: this.context.isSubagent ? "subagent" : "root",
		};
	}

	private emit(name: string, measurements: RelayMeasurement[]): void {
		try {
			this.relay.metric(name, measurements, this.parent);
		} catch (error) {
			this.onFailure(error);
		}
	}

	private guard(operation: () => void): void {
		try {
			operation();
		} catch (error) {
			this.onFailure(error);
		}
	}
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return isNonNegativeSafeInteger(value) && value > 0;
}
