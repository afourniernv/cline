import type {
	AgentModel,
	AgentModelEvent,
	AgentModelRequest,
	AgentTool,
	AgentToolContext,
	AgentUsage,
	BasicLogger,
} from "@cline/shared";
import {
	type NemoRelayRunContext,
	type NemoRelayRunInstrumentation,
	type RelayMeasurement,
	type RelayModule,
	type RelayScopeHandle,
	relayRuntimeEnums,
} from "./contracts";
import {
	boundedMetadataId,
	boundedText,
	MAX_COLLECTION_ITEMS,
	MAX_KEY_CHARS,
	projectJson,
} from "./projection";

function safeErrorType(error: unknown): string {
	if (error instanceof AggregateError) return "AggregateError";
	if (error instanceof TypeError) return "TypeError";
	if (error instanceof RangeError) return "RangeError";
	if (error instanceof ReferenceError) return "ReferenceError";
	if (error instanceof SyntaxError) return "SyntaxError";
	if (error instanceof URIError) return "URIError";
	if (error instanceof EvalError) return "EvalError";
	if (error instanceof Error) return "Error";
	if (error === null) return "ThrownNull";
	const type = typeof error;
	return `Thrown${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

export function errorSummary(error: unknown): { name: string } {
	try {
		return { name: safeErrorType(error) };
	} catch {
		return { name: "UnknownError" };
	}
}

export function safeLog(
	logger: BasicLogger | undefined,
	level: "debug" | "log" | "error",
	message: string,
	metadata?: Parameters<BasicLogger["log"]>[1] & { error?: unknown },
): void {
	try {
		if (!logger) return;
		if (level === "error") {
			(logger.error ?? logger.log).call(logger, message, metadata);
			return;
		}
		logger[level](message, metadata);
	} catch {
		// Relay diagnostics must never change agent behavior.
	}
}

function normalizeProviderErrorClass(
	value: unknown,
): Extract<AgentModelEvent, { type: "finish" }>["errorClass"] {
	return value === "auth" ||
		value === "context_window_exceeded" ||
		value === "unknown"
		? value
		: value === undefined
			? undefined
			: "unknown";
}

function accumulateUsage(
	current: Partial<AgentUsage> | undefined,
	delta: Partial<AgentUsage>,
): Partial<AgentUsage> | undefined {
	const accumulated = (key: keyof AgentUsage): number | undefined => {
		const previous = current?.[key];
		const next = delta[key];
		const hasPrevious =
			typeof previous === "number" && Number.isFinite(previous);
		const hasNext = typeof next === "number" && Number.isFinite(next);
		return hasPrevious || hasNext
			? (hasPrevious ? previous : 0) + (hasNext ? next : 0)
			: undefined;
	};
	const result: Partial<AgentUsage> = {};
	for (const key of [
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens",
		"reasoningTokenCount",
		"totalCost",
	] as const) {
		const value = accumulated(key);
		if (value !== undefined) result[key] = value;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export class RunInstrumentation implements NemoRelayRunInstrumentation {
	constructor(
		private readonly relay: RelayModule,
		private readonly parent: RelayScopeHandle,
		private readonly context: NemoRelayRunContext,
		private readonly logger?: BasicLogger,
	) {}

	wrapModel(
		model: AgentModel,
		providerId: string,
		modelId: string,
	): AgentModel {
		const instrumentation = this;
		return {
			stream(request: AgentModelRequest): AsyncIterable<AgentModelEvent> {
				return instrumentation.observeModelAttempt(
					model,
					request,
					providerId,
					modelId,
				);
			},
		};
	}

	wrapTools(tools: AgentTool[]): AgentTool[] {
		return tools.map((tool) => ({
			...tool,
			execute: (input: unknown, context: AgentToolContext) =>
				this.observeToolExecution(tool, input, context),
		}));
	}

	private async *observeModelAttempt(
		model: AgentModel,
		request: AgentModelRequest,
		providerId: string,
		modelId: string,
	): AsyncIterable<AgentModelEvent> {
		const projectedRequest = projectJson({
			headers: {},
			content: {
				// Keep Cline's normalized request under a Cline-specific key. Relay's
				// provider codecs must not mistake this for an OpenAI wire payload.
				cline_request: {
					system_prompt: request.systemPrompt,
					messages: request.messages,
					tools: request.tools,
					model_tools: request.modelTools,
					options: request.options,
				},
			},
		});
		let handle: ReturnType<RelayModule["llmCall"]> | undefined;
		try {
			const boundedProviderId = boundedMetadataId(providerId);
			handle = this.relay.llmCall(
				"cline.agent_model",
				projectedRequest.value,
				this.parent,
				null,
				null,
				{
					"cline.coverage": "normalized_partial",
					"cline.operation": "agent_model",
					"cline.provider_id": boundedProviderId,
					...(boundedProviderId.length < providerId.length
						? { "cline.provider_id_truncated": true }
						: {}),
					...(projectedRequest.omissionReason
						? { "cline.request_omission": projectedRequest.omissionReason }
						: {}),
				},
				boundedMetadataId(modelId),
			);
			if (projectedRequest.omissionReason) {
				this.emitOmission("model", projectedRequest.omissionReason);
			}
		} catch (error) {
			this.logFailure("start model observation", error);
		}

		let text = "";
		let reasoning = "";
		let redactedReasoning = false;
		let truncated = false;
		let finishReason: string | undefined;
		let errorClass: Extract<AgentModelEvent, { type: "finish" }>["errorClass"];
		let errorRetryable: unknown;
		let usage: Partial<AgentUsage> | undefined;
		const toolCallIds = new Set<string>();
		let toolCallIdsTruncated = false;
		let omittedModelOutput = false;
		const outputOmissions = new Set<string>();
		let completed = false;
		let failed = false;
		const startedAt = performance.now();
		try {
			const stream = await model.stream(request);
			for await (const event of stream) {
				switch (event.type) {
					case "text-delta": {
						const next = boundedText(text, event.text);
						text = next.text;
						truncated ||= next.truncated;
						break;
					}
					case "reasoning-delta": {
						if (event.redacted) {
							redactedReasoning = true;
							break;
						}
						const next = boundedText(reasoning, event.text);
						reasoning = next.text;
						truncated ||= next.truncated;
						break;
					}
					case "tool-call-delta":
					case "tool-result":
						if (event.toolCallId) {
							const boundedToolCallId = event.toolCallId.slice(
								0,
								MAX_KEY_CHARS,
							);
							if (boundedToolCallId.length < event.toolCallId.length) {
								toolCallIdsTruncated = true;
							}
							if (!toolCallIds.has(boundedToolCallId)) {
								if (toolCallIds.size < MAX_COLLECTION_ITEMS) {
									toolCallIds.add(boundedToolCallId);
								} else {
									toolCallIdsTruncated = true;
								}
							}
						}
						omittedModelOutput = true;
						break;
					case "media":
						omittedModelOutput = true;
						break;
					case "usage":
						usage = accumulateUsage(usage, event.usage);
						break;
					case "finish":
						finishReason = event.reason;
						errorClass = event.errorClass;
						errorRetryable = event.errorRetryable;
						break;
				}
				yield event;
			}
			completed = true;
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			if (truncated) {
				outputOmissions.add("payload_truncated");
				this.emitOmission("model", "payload_truncated");
			}
			if (omittedModelOutput) {
				outputOmissions.add("non_text_output_not_projected");
				this.emitOmission("model", "non_text_output_not_projected");
			}
			if (redactedReasoning) {
				outputOmissions.add("redacted_reasoning_not_projected");
				this.emitOmission("model", "redacted_reasoning_not_projected");
			}
			if (toolCallIdsTruncated) {
				outputOmissions.add("tool_call_count_truncated");
				this.emitOmission("model", "tool_call_count_truncated");
			}
			const outcome = failed
				? "failed"
				: !completed
					? "interrupted"
					: finishReason === "error"
						? "failed"
						: finishReason === "aborted"
							? "aborted"
							: finishReason === "content-filter"
								? "filtered"
								: finishReason === "max-tokens"
									? "limited"
									: "completed";
			const boundedErrorClass =
				outcome === "failed"
					? normalizeProviderErrorClass(errorClass)
					: undefined;
			const boundedErrorRetryable =
				outcome === "failed" && typeof errorRetryable === "boolean"
					? errorRetryable
					: undefined;
			this.emitModelMetrics(
				outcome,
				performance.now() - startedAt,
				usage,
				boundedErrorClass,
				boundedErrorRetryable,
			);
			if (handle) {
				try {
					const projectedResponse = projectJson({
						cline_response: {
							text,
							...(reasoning ? { reasoning } : {}),
							...(usage ? { usage } : {}),
							...(toolCallIds.size > 0
								? { tool_call_count: toolCallIds.size }
								: {}),
							finish_reason:
								finishReason ??
								(failed ? "error" : completed ? "unknown" : "interrupted"),
							truncated,
						},
					});
					if (projectedResponse.omissionReason) {
						outputOmissions.add(projectedResponse.omissionReason);
						this.emitOmission("model", projectedResponse.omissionReason);
					}
					this.relay.llmCallEnd(handle, projectedResponse.value, null, {
						"cline.outcome": outcome,
						"cline.coverage": "normalized_partial",
						...(boundedErrorClass
							? { "cline.error_class": boundedErrorClass }
							: {}),
						...(boundedErrorRetryable === undefined
							? {}
							: { "cline.error_retryable": boundedErrorRetryable }),
						...(outputOmissions.size > 0
							? { "cline.omissions": [...outputOmissions] }
							: {}),
					});
				} catch (error) {
					this.logFailure("finish model observation", error);
				}
			}
		}
	}

	private async observeToolExecution(
		tool: AgentTool,
		input: unknown,
		context: AgentToolContext,
	): Promise<unknown> {
		const projectedInput = projectJson(input);
		let handle: ReturnType<RelayModule["toolCall"]> | undefined;
		try {
			const toolName = boundedMetadataId(tool.name);
			const toolCallId = context.toolCallId
				? boundedMetadataId(context.toolCallId)
				: undefined;
			handle = this.relay.toolCall(
				toolName,
				projectedInput.value,
				this.parent,
				null,
				null,
				{
					"cline.coverage": "post_approval_observation",
					...(toolName.length < tool.name.length
						? { "cline.tool_name_truncated": true }
						: {}),
					...(toolCallId !== undefined &&
					context.toolCallId !== undefined &&
					toolCallId.length < context.toolCallId.length
						? { "cline.tool_call_id_truncated": true }
						: {}),
				},
				toolCallId ?? null,
			);
		} catch (error) {
			this.logFailure("start tool observation", error);
		}
		if (projectedInput.omissionReason) {
			this.emitOmission("tool", projectedInput.omissionReason);
		}

		let outcome: "completed" | "failed" = "completed";
		let output: unknown;
		let executionFailed = false;
		let executionError: unknown;
		const startedAt = performance.now();
		this.emitActiveTools(1);
		try {
			output = await tool.execute.call(tool, input, context);
		} catch (error) {
			outcome = "failed";
			executionFailed = true;
			executionError = error;
		} finally {
			this.emitActiveTools(-1);
			this.emitToolMetrics(outcome, performance.now() - startedAt);
		}

		if (executionFailed) {
			if (handle) {
				try {
					const errorType = errorSummary(executionError).name;
					this.relay.toolCallEnd(
						handle,
						{ result: { error: true }, annotation: { is_error: true } },
						null,
						{
							"cline.outcome": "failed",
							"otel.status_code": "ERROR",
							"error.type": errorType,
						},
					);
				} catch (observationError) {
					this.logFailure("finish failed tool observation", observationError);
				}
			}
			throw executionError;
		}

		if (handle) {
			const projectedOutput = projectJson(output);
			try {
				this.relay.toolCallEnd(handle, { result: projectedOutput.value });
				if (projectedOutput.omissionReason) {
					this.emitOmission("tool", projectedOutput.omissionReason);
				}
			} catch (error) {
				this.logFailure("finish tool observation", error);
			}
		}
		return output;
	}

	private emitActiveTools(value: 1 | -1): void {
		const enums = relayRuntimeEnums(this.relay);
		this.safeMetric("cline.agent.tool.active", [
			{
				name: "cline.agent.active_tools",
				kind: enums.MetricKind.UpDownCounter,
				valueType: enums.MetricValueType.I64,
				value,
				attributes: {
					surface: this.context.surface,
					mode: this.context.mode,
				},
			},
		]);
	}

	private emitModelMetrics(
		outcome: string,
		durationMs: number,
		usage: Partial<AgentUsage> | undefined,
		errorClass: Extract<AgentModelEvent, { type: "finish" }>["errorClass"],
		errorRetryable: boolean | undefined,
	): void {
		const enums = relayRuntimeEnums(this.relay);
		const attributes = {
			outcome,
			surface: this.context.surface,
			mode: this.context.mode,
			...(errorClass ? { error_class: errorClass } : {}),
			...(errorRetryable === undefined
				? {}
				: { error_retryable: errorRetryable }),
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
				value: Math.max(0, durationMs) / 1_000,
				unit: "s",
				attributes,
			},
		];
		for (const [tokenType, value] of [
			["input", usage?.inputTokens],
			["output", usage?.outputTokens],
			["cache_read", usage?.cacheReadTokens],
			["cache_write", usage?.cacheWriteTokens],
			["reasoning", usage?.reasoningTokenCount],
		] as const) {
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value <= 0
			)
				continue;
			measurements.push({
				name: "cline.agent.model.tokens",
				kind: enums.MetricKind.Counter,
				valueType: enums.MetricValueType.U64,
				value,
				attributes: { ...attributes, token_type: tokenType },
			});
		}
		this.safeMetric("cline.agent.model.completed", measurements);
	}

	private emitToolMetrics(
		outcome: "completed" | "failed",
		durationMs: number,
	): void {
		const enums = relayRuntimeEnums(this.relay);
		const attributes = {
			outcome,
			surface: this.context.surface,
			mode: this.context.mode,
		};
		this.safeMetric("cline.agent.tool.completed", [
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

	private emitOmission(operation: "model" | "tool", reason: string): void {
		const enums = relayRuntimeEnums(this.relay);
		this.safeMetric("cline.agent.observation.omitted", [
			{
				name: "cline.agent.observation.omissions",
				kind: enums.MetricKind.Counter,
				valueType: enums.MetricValueType.U64,
				value: 1,
				attributes: { operation, reason, surface: this.context.surface },
			},
		]);
	}

	private safeMetric(
		name: string,
		measurements: Parameters<RelayModule["metric"]>[1],
	): void {
		try {
			this.relay.metric(name, measurements, this.parent);
		} catch (error) {
			this.logFailure("emit Relay metric", error);
		}
	}

	private logFailure(operation: string, error: unknown): void {
		safeLog(this.logger, "debug", `Failed to ${operation}`, {
			component: "nemo-relay",
			error: errorSummary(error),
		});
	}
}
