import type { AgentModel, AgentModelEvent, AgentTool } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { NemoRelayRuntimeManager } from "./runtime";
import { agentResult, createRelayHarness, runContext } from "./test-support";

describe("NemoRelay runtime instrumentation", () => {
	it("observes Cline-visible model invocations and actual post-approval tool executions", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		const events: AgentModelEvent[] = [
			{ type: "text-delta", text: "hello" },
			{
				type: "usage",
				usage: { inputTokens: 3, outputTokens: 1, totalCost: 0.0125 },
			},
			{ type: "tool-call-delta", toolCallId: "model-tool-call" },
			{ type: "finish", reason: "stop" },
		];
		const model: AgentModel = {
			async *stream() {
				for (const event of events) yield event;
			},
		};
		const tool: AgentTool = {
			name: "secret-tool-name",
			description: "test",
			inputSchema: {},
			execute: async () => ({ secret: "tool-result" }),
		};

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const wrappedModel = instrumentation.wrapModel(
				model,
				"secret-provider",
				"secret-model",
			);
			const observed: AgentModelEvent[] = [];
			const stream = await wrappedModel.stream({
				messages: [],
				tools: [],
			});
			for await (const event of stream) {
				observed.push(event);
			}
			expect(observed).toEqual(events);

			const [wrappedTool] = instrumentation.wrapTools([tool]);
			await expect(
				wrappedTool.execute(
					{ secret: "tool-input" },
					{ agentId: "agent", iteration: 1, toolCallId: "call" },
				),
			).resolves.toEqual({ secret: "tool-result" });
			return agentResult();
		});

		expect(harness.llmStarts).toHaveLength(1);
		expect(harness.llmStarts[0]?.[0]).toBe("cline.agent_model");
		expect(harness.llmStarts[0]?.[5]).toMatchObject({
			"cline.provider_id": "secret-provider",
		});
		expect(harness.llmStarts[0]?.[1]).toMatchObject({
			content: { cline_request: expect.any(Object) },
		});
		expect(harness.llmStarts[0]?.[1]).not.toHaveProperty("content.messages");
		expect(harness.llmEnds).toHaveLength(1);
		expect(harness.toolStarts).toHaveLength(1);
		expect(harness.toolEnds).toHaveLength(1);
		const metricText = JSON.stringify(harness.metrics);
		expect(metricText).not.toContain("secret-tool-name");
		expect(metricText).not.toContain("secret-provider");
		expect(metricText).not.toContain("secret-model");
		expect(metricText).not.toContain("tool-input");
		expect(metricText).not.toContain("tool-result");
		const runMeasurements = harness.metrics.find(
			(metric) => metric.name === "cline.agent.run.completed",
		)?.measurements as Array<Record<string, unknown>>;
		expect(runMeasurements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "cline.agent.runs",
					value: 1,
					attributes: {
						outcome: "completed",
						surface: "cli",
						mode: "act",
						agent_kind: "root",
						used_skills_tool: false,
					},
				}),
				expect.objectContaining({
					name: "cline.agent.run.duration",
					unit: "s",
				}),
				expect.objectContaining({
					name: "cline.agent.run.iterations",
					value: 1,
				}),
				expect.objectContaining({
					name: "cline.agent.run.model_attempts",
					value: 1,
				}),
				expect.objectContaining({
					name: "cline.agent.run.peak_active_tools",
					value: 1,
				}),
				expect.objectContaining({
					name: "cline.agent.run.skills_tool_calls",
					value: 0,
				}),
			]),
		);
		const toolMeasurements = harness.metrics.find(
			(metric) => metric.name === "cline.agent.tool.completed",
		)?.measurements as Array<Record<string, unknown>>;
		expect(toolMeasurements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "cline.agent.tool.executions",
					value: 1,
				}),
				expect.objectContaining({
					name: "cline.agent.tool.duration",
					unit: "s",
				}),
			]),
		);
		const modelMeasurements = harness.metrics.find(
			(metric) => metric.name === "cline.agent.model.completed",
		)?.measurements as Array<Record<string, unknown>>;
		expect(modelMeasurements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "cline.agent.model.calls",
					value: 1,
				}),
				expect.objectContaining({
					name: "cline.agent.model.duration",
					unit: "s",
				}),
				expect.objectContaining({
					name: "cline.agent.model.tokens",
					value: 3,
					unit: "{token}",
					attributes: expect.objectContaining({ token_type: "input" }),
				}),
				expect.objectContaining({
					name: "cline.agent.model.cost",
					value: 0.0125,
					unit: "USD",
				}),
				expect.objectContaining({
					name: "cline.agent.model.tool_calls",
					value: 1,
				}),
			]),
		);
		for (const metric of harness.metrics) {
			for (const measurement of metric.measurements as Array<
				Record<string, unknown>
			>) {
				expect(measurement.attributes).toMatchObject({ agent_kind: "root" });
			}
		}
		const activeToolValues = harness.metrics
			.filter((metric) => metric.name === "cline.agent.tool.active")
			.flatMap((metric) =>
				(metric.measurements as Array<Record<string, unknown>>).map(
					(measurement) => measurement.value,
				),
			);
		expect(activeToolValues).toEqual([1, -1]);
		await owner.release();
	});

	it("tracks overlapping post-approval tool callbacks without leaking labels", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		let releaseTools!: () => void;
		const toolGate = new Promise<void>((resolve) => {
			releaseTools = resolve;
		});
		let started = 0;
		let bothStarted!: () => void;
		const bothStartedPromise = new Promise<void>((resolve) => {
			bothStarted = resolve;
		});

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const [tool] = instrumentation.wrapTools([
				{
					name: "private-tool-name",
					description: "test",
					inputSchema: {},
					execute: async () => {
						started += 1;
						if (started === 2) bothStarted();
						await toolGate;
						return "done";
					},
				},
			]);
			const calls = [
				tool.execute(undefined, {
					agentId: "agent",
					iteration: 1,
					toolCallId: "one",
				}),
				tool.execute(undefined, {
					agentId: "agent",
					iteration: 1,
					toolCallId: "two",
				}),
			];
			await bothStartedPromise;
			const activeValues = () =>
				harness.metrics
					.filter((metric) => metric.name === "cline.agent.tool.active")
					.flatMap((metric) =>
						(metric.measurements as Array<Record<string, unknown>>).map(
							(measurement) => measurement.value,
						),
					);
			expect(activeValues()).toEqual([1, 1]);
			releaseTools();
			await Promise.all(calls);
			expect(activeValues()).toEqual([1, 1, -1, -1]);
			return agentResult();
		});

		expect(JSON.stringify(harness.metrics)).not.toContain("private-tool-name");
		const runMeasurements = harness.metrics.find(
			(metric) => metric.name === "cline.agent.run.completed",
		)?.measurements as Array<Record<string, unknown>>;
		expect(runMeasurements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "cline.agent.run.peak_active_tools",
					value: 2,
				}),
			]),
		);
		await owner.release();
	});

	it("associates only canonical skills tool executions with the run", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const [skills, similarlyNamed, failingSkills] = instrumentation.wrapTools(
				[
					{
						name: "skills",
						description: "test",
						inputSchema: {},
						execute: async () => "loaded",
					},
					{
						name: "skills-preview",
						description: "test",
						inputSchema: {},
						execute: async () => "done",
					},
					{
						name: "skills",
						description: "test",
						inputSchema: {},
						execute: async () => {
							throw new Error("load failed");
						},
					},
				],
			);
			const context = { agentId: "agent", iteration: 1, toolCallId: "call" };
			await skills.execute(undefined, context);
			await similarlyNamed.execute(undefined, context);
			await expect(failingSkills.execute(undefined, context)).rejects.toThrow(
				"load failed",
			);
			return agentResult();
		});

		const runMeasurements = harness.metrics.find(
			(metric) => metric.name === "cline.agent.run.completed",
		)?.measurements as Array<Record<string, unknown>>;
		expect(runMeasurements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "cline.agent.runs",
					attributes: expect.objectContaining({ used_skills_tool: true }),
				}),
				expect.objectContaining({
					name: "cline.agent.run.skills_tool_calls",
					value: 2,
				}),
			]),
		);
		await owner.release();
	});

	it("bounds tool names and call IDs without changing the executed tool", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		const longName = "n".repeat(300);
		const longCallId = "c".repeat(300);
		const execute = vi.fn(async () => "done");

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const [tool] = instrumentation.wrapTools([
				{ name: longName, description: "test", inputSchema: {}, execute },
			]);
			await expect(
				tool.execute("input", {
					agentId: "agent",
					iteration: 1,
					toolCallId: longCallId,
				}),
			).resolves.toBe("done");
			return agentResult();
		});

		expect(execute).toHaveBeenCalledWith("input", {
			agentId: "agent",
			iteration: 1,
			toolCallId: longCallId,
		});
		expect(harness.toolStarts[0]?.[0]).toBe("n".repeat(256));
		expect(harness.toolStarts[0]?.[5]).toMatchObject({
			"cline.tool_name_truncated": true,
			"cline.tool_call_id_truncated": true,
		});
		expect(harness.toolStarts[0]?.[6]).toBe("c".repeat(256));
		await owner.release();
	});

	it("does not copy provider-redacted reasoning into Relay events", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		const canary = "SECRET_REDACTED_REASONING";

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const model = instrumentation.wrapModel(
				{
					async *stream() {
						yield {
							type: "reasoning-delta",
							text: canary,
							redacted: true,
						} as const;
						yield {
							type: "tool-call-delta",
							toolCallId: "x".repeat(513),
						} as const;
						yield { type: "finish", reason: "stop" } as const;
					},
				},
				"provider",
				"model",
			);
			for await (const _event of await model.stream({
				messages: [],
				tools: [],
			})) {
				// Preserve the physical stream while observing a safe copy.
			}
			return agentResult();
		});

		expect(JSON.stringify(harness.llmEnds)).not.toContain(canary);
		expect(JSON.stringify(harness.llmEnds)).toContain(
			"redacted_reasoning_not_projected",
		);
		expect(JSON.stringify(harness.llmEnds)).toContain(
			"tool_call_count_truncated",
		);
		await owner.release();
	});

	it("records actual tool execution when starting Relay observation fails", async () => {
		const harness = createRelayHarness({ configured: true });
		harness.relay.toolCall.mockImplementationOnce(() => {
			throw new Error("observation unavailable");
		});
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		let executions = 0;

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const [tool] = instrumentation.wrapTools([
				{
					name: "tool",
					description: "test",
					inputSchema: {},
					execute: async () => {
						executions += 1;
						return "done";
					},
				},
			]);
			await expect(
				tool.execute(undefined, {
					agentId: "agent",
					iteration: 1,
					toolCallId: "call",
				}),
			).resolves.toBe("done");
			return agentResult();
		});

		expect(executions).toBe(1);
		expect(harness.toolEnds).toHaveLength(0);
		expect(
			harness.metrics
				.filter((metric) => metric.name === "cline.agent.tool.active")
				.flatMap((metric) =>
					(metric.measurements as Array<Record<string, unknown>>).map(
						(measurement) => measurement.value,
					),
				),
		).toEqual([1, -1]);
		expect(
			harness.metrics.find(
				(metric) => metric.name === "cline.agent.tool.completed",
			),
		).toBeDefined();
		await owner.release();
	});

	it("keeps execution fail-open when the optional metric surface is malformed", async () => {
		const harness = createRelayHarness({ configured: true });
		(harness.relay as { MetricKind?: unknown }).MetricKind = undefined;
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		let executions = 0;

		const result = await owner.observeRun(
			runContext,
			async (instrumentation) => {
				if (!instrumentation) throw new Error("expected Relay instrumentation");
				const [tool] = instrumentation.wrapTools([
					{
						name: "tool",
						description: "test",
						inputSchema: {},
						execute: async () => {
							executions += 1;
							return "done";
						},
					},
				]);
				await tool.execute(undefined, {
					agentId: "agent",
					iteration: 1,
					toolCallId: "call",
				});
				return agentResult();
			},
		);

		expect(result.finishReason).toBe("completed");
		expect(executions).toBe(1);
		expect(harness.metrics).toEqual([]);
		await owner.release();
	});

	it("records a bounded tool error type without exporting custom error metadata", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		const failure = Object.assign(new Error("SECRET_ERROR_MESSAGE"), {
			name: "SECRET_ERROR_NAME",
			code: "SECRET_ERROR_CODE",
		});

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const [tool] = instrumentation.wrapTools([
				{
					name: "tool",
					description: "test",
					inputSchema: {},
					execute: async () => {
						throw failure;
					},
				},
			]);
			await expect(
				tool.execute(undefined, {
					agentId: "agent",
					iteration: 1,
					toolCallId: "call",
				}),
			).rejects.toBe(failure);
			return agentResult("error");
		});

		expect(harness.toolEnds[0]?.[3]).toMatchObject({
			"cline.outcome": "failed",
			"otel.status_code": "ERROR",
			"error.type": "Error",
		});
		expect(JSON.stringify(harness.toolEnds)).not.toContain("SECRET_ERROR");
		await owner.release();
	});

	it("records coarse failure state without exporting thrown error text", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		const canary = "SECRET_ERROR_CANARY";

		await expect(
			owner.observeRun(runContext, async () => {
				throw new Error(canary);
			}),
		).rejects.toThrow(canary);

		expect(JSON.stringify(harness.popped)).not.toContain(canary);
		expect(JSON.stringify(harness.metrics)).not.toContain(canary);
		await owner.release();
	});

	it("ignores logger failures without changing the application result", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const logger = {
			debug: vi.fn(() => {
				throw new Error("logger failed");
			}),
			log: vi.fn(() => {
				throw new Error("logger failed");
			}),
			error: vi.fn(() => {
				throw new Error("logger failed");
			}),
		};
		const owner = manager.acquire(logger);
		harness.relay.pushScope.mockImplementationOnce(() => {
			throw new Error("observation failed");
		});

		await expect(
			owner.observeRun(runContext, async () => agentResult()),
		).resolves.toMatchObject({ finishReason: "completed" });
		await owner.release();
	});

	it("records a yielded model error as failed without exporting its text", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const model = instrumentation.wrapModel(
				{
					async *stream() {
						yield {
							type: "finish",
							reason: "error",
							error: "SECRET_PROVIDER_ERROR",
							errorClass: "auth",
							errorRetryable: false,
						};
					},
				},
				"provider",
				"model",
			);
			for await (const _event of await model.stream({
				messages: [],
				tools: [],
			})) {
				// Consume the physical stream.
			}
			return agentResult("error");
		});

		expect(harness.llmEnds[0]?.[3]).toMatchObject({
			"cline.outcome": "failed",
			"cline.error_class": "auth",
			"cline.error_retryable": false,
		});
		expect(harness.llmEnds[0]?.[3]).not.toHaveProperty("otel.status_code");
		expect(JSON.stringify(harness.llmEnds)).not.toContain(
			"SECRET_PROVIDER_ERROR",
		);
		const modelMeasurements = harness.metrics.find(
			(metric) => metric.name === "cline.agent.model.completed",
		)?.measurements as Array<Record<string, unknown>>;
		expect(modelMeasurements[0]?.attributes).toMatchObject({
			error_class: "auth",
			error_retryable: false,
		});
		await owner.release();
	});

	it("bounds invalid model error dimensions and ignores stale success fields", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		const canary = "SECRET_INVALID_ERROR_CLASS";

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			for (const event of [
				{
					type: "finish",
					reason: "error",
					errorClass: canary,
					errorRetryable: canary,
				},
				{
					type: "finish",
					reason: "stop",
					errorClass: "auth",
					errorRetryable: true,
				},
			] as const) {
				const model = instrumentation.wrapModel(
					{
						async *stream() {
							yield event as AgentModelEvent;
						},
					},
					"not-really-openai",
					"private-model",
				);
				for await (const _result of await model.stream({
					messages: [],
					tools: [],
				})) {
					// Drain the physical stream.
				}
			}
			return agentResult();
		});

		expect(harness.llmStarts.map((args) => args[0])).toEqual([
			"cline.agent_model",
			"cline.agent_model",
		]);
		expect(harness.llmEnds[0]?.[3]).toMatchObject({
			"cline.error_class": "unknown",
		});
		expect(harness.llmEnds[0]?.[3]).not.toHaveProperty("cline.error_retryable");
		expect(harness.llmEnds[1]?.[3]).not.toHaveProperty("cline.error_class");
		expect(harness.llmEnds[1]?.[3]).not.toHaveProperty("cline.error_retryable");
		expect(JSON.stringify(harness.llmEnds)).not.toContain(canary);
		expect(JSON.stringify(harness.metrics)).not.toContain(canary);
		await owner.release();
	});

	it("accumulates repeated model usage deltas", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const model = instrumentation.wrapModel(
				{
					async *stream() {
						yield {
							type: "usage",
							usage: {
								inputTokens: 3,
								outputTokens: 1,
								cacheReadTokens: 2,
								cacheWriteTokens: 0,
								totalCost: 0.01,
							},
						} as const;
						yield {
							type: "usage",
							usage: {
								inputTokens: 4,
								outputTokens: 2,
								cacheReadTokens: 0,
								cacheWriteTokens: 1,
								totalCost: 0.02,
							},
						} as const;
						yield { type: "finish", reason: "stop" } as const;
					},
				},
				"provider",
				"model",
			);
			for await (const _event of await model.stream({
				messages: [],
				tools: [],
			})) {
				// Drain the physical stream.
			}
			return agentResult();
		});

		expect(harness.llmEnds[0]?.[1]).toMatchObject({
			cline_response: {
				usage: {
					inputTokens: 7,
					outputTokens: 3,
					cacheReadTokens: 2,
					cacheWriteTokens: 1,
					totalCost: 0.03,
				},
			},
		});
		expect(harness.llmEnds[0]?.[1]).not.toHaveProperty(
			"cline_response.usage.reasoningTokenCount",
		);
		const cost = (
			harness.metrics.find(
				(metric) => metric.name === "cline.agent.model.completed",
			)?.measurements as Array<Record<string, unknown>>
		).find((measurement) => measurement.name === "cline.agent.model.cost");
		expect(cost?.unit).toBe("USD");
		expect(cost?.value).toBeCloseTo(0.03);
		await owner.release();
	});

	it.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-0.01,
	])("omits invalid model cost %s", async (invalidCost) => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) {
				throw new Error("expected Relay instrumentation");
			}
			const model = instrumentation.wrapModel(
				{
					async *stream() {
						yield {
							type: "usage",
							usage: { totalCost: invalidCost },
						} as const;
						yield { type: "finish", reason: "stop" } as const;
					},
				},
				"provider",
				"model",
			);
			for await (const _event of await model.stream({
				messages: [],
				tools: [],
			})) {
				// Drain the physical stream.
			}
			return agentResult();
		});

		const measurements = harness.metrics.find(
			(metric) => metric.name === "cline.agent.model.completed",
		)?.measurements as Array<Record<string, unknown>>;
		expect(
			measurements.some(
				(measurement) => measurement.name === "cline.agent.model.cost",
			),
		).toBe(false);
		await owner.release();
	});

	it.each([
		["content-filter", "filtered"],
		["max-tokens", "limited"],
		["aborted", "aborted"],
	] as const)("records model finish reason %s as bounded outcome %s without an infrastructure error", async (finishReason, expectedOutcome) => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const model = instrumentation.wrapModel(
				{
					async *stream() {
						yield { type: "finish", reason: finishReason };
					},
				},
				"provider",
				"model",
			);
			for await (const _event of await model.stream({
				messages: [],
				tools: [],
			})) {
				// Consume the physical stream.
			}
			return agentResult();
		});

		expect(harness.llmEnds[0]?.[3]).toMatchObject({
			"cline.outcome": expectedOutcome,
		});
		expect(harness.llmEnds[0]?.[3]).not.toHaveProperty("otel.status_code");
		await owner.release();
	});

	it("closes the physical model iterator and records interruption on early return", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		let sourceClosed = false;

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const model = instrumentation.wrapModel(
				{
					async *stream() {
						try {
							yield { type: "text-delta", text: "first" } as const;
							yield { type: "text-delta", text: "second" } as const;
						} finally {
							sourceClosed = true;
						}
					},
				},
				"provider",
				"model",
			);
			const stream = await model.stream({ messages: [], tools: [] });
			for await (const _event of stream) break;
			return agentResult("aborted");
		});

		expect(sourceClosed).toBe(true);
		expect(harness.llmEnds[0]?.[3]).toMatchObject({
			"cline.outcome": "interrupted",
		});
		expect(harness.llmEnds[0]?.[3]).not.toHaveProperty("otel.status_code");
		await owner.release();
	});
});
