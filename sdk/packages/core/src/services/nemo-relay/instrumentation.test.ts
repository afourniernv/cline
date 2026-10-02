import type {
	AgentModel,
	AgentModelEvent,
	AgentResult,
	AgentTool,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	type NemoRelayRunInstrumentation,
	NemoRelayRuntimeManager,
} from "./runtime";
import { agentResult, createRelayHarness, runContext } from "./test-support";

const EMPTY_MODEL_REQUEST = { messages: [], tools: [] };

async function drainModel(model: AgentModel): Promise<AgentModelEvent[]> {
	const events: AgentModelEvent[] = [];
	for await (const event of await model.stream(EMPTY_MODEL_REQUEST)) {
		events.push(event);
	}
	return events;
}

async function observeWithHarness(
	harness: ReturnType<typeof createRelayHarness>,
	execute: (
		instrumentation?: NemoRelayRunInstrumentation,
	) => Promise<AgentResult>,
): Promise<AgentResult> {
	const owner = new NemoRelayRuntimeManager({
		load: async () => harness.modules,
	}).acquire();
	try {
		return await owner.observeRun(runContext, execute);
	} finally {
		await owner.release();
	}
}

describe("NemoRelay runtime instrumentation", () => {
	it("observes Cline-visible model invocations and actual post-approval tool executions", async () => {
		const harness = createRelayHarness({ configured: true });
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

		await observeWithHarness(harness, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const wrappedModel = instrumentation.wrapModel(
				model,
				"secret-provider",
				"secret-model",
			);
			const observed = await drainModel(wrappedModel);
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
		expect(harness.metrics.map(({ name }) => name)).toContain(
			"cline.agent.model.completed",
		);
		const modelCompleted = harness.metrics.find(
			({ name }) => name === "cline.agent.model.completed",
		);
		expect(modelCompleted?.measurements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "cline.agent.model.time_to_first_event",
				}),
			]),
		);
		expect(harness.metrics.map(({ name }) => name)).toContain(
			"cline.agent.tool.completed",
		);
	});

	it("tracks overlapping post-approval tool executions", async () => {
		const harness = createRelayHarness({ configured: true });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = 0;
		let bothStarted!: () => void;
		const both = new Promise<void>((resolve) => {
			bothStarted = resolve;
		});

		await observeWithHarness(harness, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const [tool] = instrumentation.wrapTools([
				{
					name: "private-tool-name",
					description: "test",
					inputSchema: {},
					execute: async () => {
						started += 1;
						if (started === 2) bothStarted();
						await gate;
						return "done";
					},
				},
			]);
			const calls = ["one", "two"].map((toolCallId) =>
				tool.execute(undefined, { agentId: "agent", iteration: 1, toolCallId }),
			);
			await both;
			release();
			await Promise.all(calls);
			return agentResult();
		});

		const values = harness.metrics
			.filter(({ name }) => name === "cline.agent.tool.active")
			.flatMap(({ measurements }) =>
				(measurements as Array<{ value: number }>).map(({ value }) => value),
			);
		expect(values).toEqual([1, 1, -1, -1]);
		expect(JSON.stringify(harness.metrics)).not.toContain("private-tool-name");
	});

	it("closes concurrent model streams once when they finish out of order", async () => {
		const harness = createRelayHarness({ configured: true });
		let releaseSlow!: () => void;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let slowClosed = 0;
		let fastClosed = 0;

		await observeWithHarness(harness, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const slow = instrumentation.wrapModel(
				{
					async *stream() {
						try {
							yield { type: "text-delta", text: "slow" } as const;
							await slowGate;
							yield { type: "finish", reason: "stop" } as const;
						} finally {
							slowClosed += 1;
						}
					},
				},
				"provider",
				"slow",
			);
			const fast = instrumentation.wrapModel(
				{
					async *stream() {
						try {
							yield { type: "finish", reason: "stop" } as const;
						} finally {
							fastClosed += 1;
						}
					},
				},
				"provider",
				"fast",
			);

			const slowDrain = drainModel(slow);
			await drainModel(fast);
			releaseSlow();
			await slowDrain;
			return agentResult();
		});

		expect([fastClosed, slowClosed]).toEqual([1, 1]);
		expect(harness.llmEnds).toHaveLength(2);
		expect(
			harness.metrics
				.filter(({ name }) => name === "cline.agent.model.active")
				.flatMap(({ measurements }) =>
					(measurements as Array<{ value: number }>).map(({ value }) => value),
				),
		).toEqual([1, 1, -1, -1]);
	});

	it("omits first-event latency for an empty model stream", async () => {
		const harness = createRelayHarness({ configured: true });

		await observeWithHarness(harness, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			await drainModel(
				instrumentation.wrapModel({ async *stream() {} }, "provider", "empty"),
			);
			return agentResult();
		});

		const completed = harness.metrics.find(
			({ name }) => name === "cline.agent.model.completed",
		);
		expect(completed?.measurements).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "cline.agent.model.time_to_first_event",
				}),
			]),
		);
	});

	it("bounds tool names and call IDs without changing the executed tool", async () => {
		const harness = createRelayHarness({ configured: true });
		const longName = "n".repeat(300);
		const longCallId = "c".repeat(300);
		const execute = vi.fn(async () => "done");

		await observeWithHarness(harness, async (instrumentation) => {
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
	});

	it("does not copy provider-redacted reasoning into Relay events", async () => {
		const harness = createRelayHarness({ configured: true });
		const canary = "SECRET_REDACTED_REASONING";

		await observeWithHarness(harness, async (instrumentation) => {
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
			await drainModel(model);
			return agentResult();
		});

		expect(JSON.stringify(harness.llmEnds)).not.toContain(canary);
		expect(JSON.stringify(harness.llmEnds)).toContain(
			"redacted_reasoning_not_projected",
		);
		expect(JSON.stringify(harness.llmEnds)).toContain(
			"tool_call_count_truncated",
		);
	});

	it("records actual tool execution when starting Relay observation fails", async () => {
		const harness = createRelayHarness({ configured: true });
		harness.relay.toolCall.mockImplementationOnce(() => {
			throw new Error("observation unavailable");
		});
		let executions = 0;

		await observeWithHarness(harness, async (instrumentation) => {
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
	});

	it("records a bounded tool error type without exporting custom error metadata", async () => {
		const harness = createRelayHarness({ configured: true });
		const failure = Object.assign(new Error("SECRET_ERROR_MESSAGE"), {
			name: "SECRET_ERROR_NAME",
			code: "SECRET_ERROR_CODE",
		});

		await observeWithHarness(harness, async (instrumentation) => {
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
	});

	it("records a yielded model error as failed without exporting its text", async () => {
		const harness = createRelayHarness({ configured: true });
		await observeWithHarness(harness, async (instrumentation) => {
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
			await drainModel(model);
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
	});

	it("bounds invalid model error dimensions and ignores stale success fields", async () => {
		const harness = createRelayHarness({ configured: true });
		const canary = "SECRET_INVALID_ERROR_CLASS";

		await observeWithHarness(harness, async (instrumentation) => {
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
				await drainModel(model);
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
	});

	it("accumulates repeated model usage deltas", async () => {
		const harness = createRelayHarness({ configured: true });
		await observeWithHarness(harness, async (instrumentation) => {
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
			await drainModel(model);
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
	});

	it.each([
		["content-filter", "filtered"],
		["max-tokens", "limited"],
		["aborted", "aborted"],
	] as const)("records model finish reason %s as bounded outcome %s without an infrastructure error", async (finishReason, expectedOutcome) => {
		const harness = createRelayHarness({ configured: true });
		await observeWithHarness(harness, async (instrumentation) => {
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
			await drainModel(model);
			return agentResult();
		});

		expect(harness.llmEnds[0]?.[3]).toMatchObject({
			"cline.outcome": expectedOutcome,
		});
		expect(harness.llmEnds[0]?.[3]).not.toHaveProperty("otel.status_code");
	});

	it("closes the physical model iterator and records interruption on early return", async () => {
		const harness = createRelayHarness({ configured: true });
		let sourceClosed = false;

		await observeWithHarness(harness, async (instrumentation) => {
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
			const stream = await model.stream(EMPTY_MODEL_REQUEST);
			for await (const _event of stream) break;
			return agentResult("aborted");
		});

		expect(sourceClosed).toBe(true);
		expect(harness.llmEnds[0]?.[3]).toMatchObject({
			"cline.outcome": "interrupted",
		});
		expect(harness.llmEnds[0]?.[3]).not.toHaveProperty("otel.status_code");
	});
});
