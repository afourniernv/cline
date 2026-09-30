import type { AgentModel, AgentTool } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NemoRelayRuntimeManager } from "./runtime";
import { agentResult, createRelayHarness, runContext } from "./test-support";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

function sessionId(metadata: unknown): string | undefined {
	return (metadata as Record<string, unknown> | undefined)?.[
		"cline.session_id"
	] as string | undefined;
}

function activeToolValues(
	metrics: Array<{ name: string; measurements: unknown[] }>,
): number[] {
	return metrics
		.filter((metric) => metric.name === "cline.agent.tool.active")
		.flatMap((metric) =>
			(metric.measurements as Array<{ value: number }>).map(
				(measurement) => measurement.value,
			),
		);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("NeMo Relay concurrency qualification", () => {
	it("isolates concurrent roots, reverse-order subagents and tools, and early stream cancellation", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		const borrower = manager.borrow();
		const rootsReady = deferred();
		let rootsEntered = 0;
		const enterRoot = () => {
			rootsEntered += 1;
			if (rootsEntered === 2) rootsReady.resolve();
		};

		const childOneGate = deferred();
		const childTwoGate = deferred();
		const childOneStarted = deferred();
		const childTwoStarted = deferred();
		const rootA = owner.observeRun(
			{ ...runContext, sessionId: "root-a" },
			async () => {
				enterRoot();
				await rootsReady.promise;
				const childOne = borrower.observeRun(
					{ ...runContext, sessionId: "child-one", isSubagent: true },
					async () => {
						childOneStarted.resolve();
						await childOneGate.promise;
						return agentResult();
					},
				);
				const childTwo = borrower.observeRun(
					{ ...runContext, sessionId: "child-two", isSubagent: true },
					async () => {
						childTwoStarted.resolve();
						await childTwoGate.promise;
						return agentResult();
					},
				);
				await Promise.all([childOneStarted.promise, childTwoStarted.promise]);
				childTwoGate.resolve();
				await childTwo;
				childOneGate.resolve();
				await childOne;
				return agentResult();
			},
		);

		const toolOneGate = deferred();
		const toolTwoGate = deferred();
		const toolOneStarted = deferred();
		const toolTwoStarted = deferred();
		let sourceClosed = false;
		const rootB = owner.observeRun(
			{ ...runContext, sessionId: "root-b" },
			async (instrumentation) => {
				if (!instrumentation) throw new Error("expected Relay instrumentation");
				enterRoot();
				await rootsReady.promise;
				const tools: AgentTool[] = instrumentation.wrapTools([
					{
						name: "tool-one",
						description: "test",
						inputSchema: {},
						execute: async () => {
							toolOneStarted.resolve();
							await toolOneGate.promise;
							return "one";
						},
					},
					{
						name: "tool-two",
						description: "test",
						inputSchema: {},
						execute: async () => {
							toolTwoStarted.resolve();
							await toolTwoGate.promise;
							return "two";
						},
					},
				]);
				const toolOne = tools[0].execute(undefined, {
					agentId: "root-b",
					iteration: 1,
					toolCallId: "tool-one",
				});
				const toolTwo = tools[1].execute(undefined, {
					agentId: "root-b",
					iteration: 1,
					toolCallId: "tool-two",
				});
				await Promise.all([toolOneStarted.promise, toolTwoStarted.promise]);
				toolTwoGate.resolve();
				await toolTwo;
				toolOneGate.resolve();
				await toolOne;

				const model: AgentModel = instrumentation.wrapModel(
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
				for await (const _event of await model.stream({
					messages: [],
					tools: [],
				})) {
					break;
				}
				return agentResult("aborted");
			},
		);

		await Promise.all([rootA, rootB]);

		const runStarts = harness.operations.filter(
			(operation) =>
				operation.kind === "push" && operation.name === "cline.run",
		);
		expect(runStarts).toHaveLength(4);
		expect(new Set(runStarts.map(({ stackId }) => stackId)).size).toBe(4);
		const rootAStart = runStarts.find(
			(operation) => sessionId(operation.metadata) === "root-a",
		);
		const childStacks = harness.stacks.filter(
			(stack) => stack.propagatedFrom !== null,
		);
		expect(childStacks).toHaveLength(2);
		expect(childStacks.map(({ propagatedFrom }) => propagatedFrom)).toEqual([
			rootAStart?.handle,
			rootAStart?.handle,
		]);

		const toolNames = new Map(
			harness.operations
				.filter((operation) => operation.kind === "tool-start")
				.map((operation) => [operation.handle, operation.name]),
		);
		expect(
			harness.operations
				.filter((operation) => operation.kind === "tool-end")
				.map((operation) => toolNames.get(operation.handle)),
		).toEqual(["tool-two", "tool-one"]);
		expect(activeToolValues(harness.metrics)).toEqual([1, 1, -1, -1]);
		expect(sourceClosed).toBe(true);
		expect(harness.violations).toEqual([]);
		expect(harness.stacks.every((stack) => stack.frames.length === 0)).toBe(
			true,
		);

		await owner.release();
		expect(harness.order).toEqual(["flush", "close"]);
	});

	it("lets an aborted parent end before live child branches while final shutdown still drains them", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		const borrower = manager.borrow();
		const childOneGate = deferred();
		const childTwoGate = deferred();
		const childOneStarted = deferred();
		const childTwoStarted = deferred();
		let childOne!: Promise<ReturnType<typeof agentResult>>;
		let childTwo!: Promise<ReturnType<typeof agentResult>>;

		await owner.observeRun({ ...runContext, sessionId: "parent" }, async () => {
			childOne = borrower.observeRun(
				{ ...runContext, sessionId: "live-child-one", isSubagent: true },
				async () => {
					childOneStarted.resolve();
					await childOneGate.promise;
					return agentResult();
				},
			);
			childTwo = borrower.observeRun(
				{ ...runContext, sessionId: "live-child-two", isSubagent: true },
				async () => {
					childTwoStarted.resolve();
					await childTwoGate.promise;
					return agentResult("aborted");
				},
			);
			await Promise.all([childOneStarted.promise, childTwoStarted.promise]);
			return agentResult("aborted");
		});

		const parentStart = harness.operations.find(
			(operation) =>
				operation.kind === "push" && sessionId(operation.metadata) === "parent",
		);
		expect(
			harness.operations.some(
				(operation) =>
					operation.kind === "pop" && operation.handle === parentStart?.handle,
			),
		).toBe(true);
		expect(harness.popped).toHaveLength(1);

		const releasing = owner.release();
		await Promise.resolve();
		expect(harness.order).toEqual([]);
		childTwoGate.resolve();
		await childTwo;
		expect(harness.order).toEqual([]);
		childOneGate.resolve();
		await childOne;
		await releasing;

		expect(harness.popped).toHaveLength(3);
		expect(harness.violations).toEqual([]);
		expect(harness.stacks.every((stack) => stack.frames.length === 0)).toBe(
			true,
		);
		expect(harness.order).toEqual(["flush", "close"]);
	});

	it("closes parallel model streams exactly once when they finish out of order", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		const slowGate = deferred();
		const slowStarted = deferred();
		const earlyStarted = deferred();
		let slowCloses = 0;
		let earlyCloses = 0;

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const slow = instrumentation.wrapModel(
				{
					async *stream() {
						slowStarted.resolve();
						try {
							yield { type: "text-delta", text: "slow" } as const;
							await slowGate.promise;
							yield { type: "finish", reason: "stop" } as const;
						} finally {
							slowCloses += 1;
						}
					},
				},
				"provider",
				"slow-model",
			);
			const early = instrumentation.wrapModel(
				{
					async *stream() {
						earlyStarted.resolve();
						try {
							yield { type: "text-delta", text: "early" } as const;
							yield { type: "finish", reason: "stop" } as const;
						} finally {
							earlyCloses += 1;
						}
					},
				},
				"provider",
				"early-model",
			);

			const slowConsumption = (async () => {
				for await (const _event of await slow.stream({
					messages: [],
					tools: [],
				})) {
					// Drain the complete stream.
				}
			})();
			const earlyConsumption = (async () => {
				for await (const _event of await early.stream({
					messages: [],
					tools: [],
				})) {
					break;
				}
			})();
			await Promise.all([slowStarted.promise, earlyStarted.promise]);
			await earlyConsumption;
			expect(earlyCloses).toBe(1);
			slowGate.resolve();
			await slowConsumption;
			expect(slowCloses).toBe(1);
			return agentResult();
		});

		expect(harness.llmStarts).toHaveLength(2);
		expect(harness.llmEnds).toHaveLength(2);
		const starts = harness.operations.filter(
			(operation) => operation.kind === "llm-start",
		);
		const ends = harness.operations.filter(
			(operation) => operation.kind === "llm-end",
		);
		expect(ends.map(({ handle }) => handle)).toEqual([
			starts[1]?.handle,
			starts[0]?.handle,
		]);
		expect(harness.violations).toEqual([]);
		await owner.release();
	});

	it("flushes and closes exactly once when the final owners release together", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const first = manager.acquire();
		const second = manager.acquire();
		await Promise.all([first.state(), second.state()]);

		await Promise.all([first.release(), second.release()]);

		expect(harness.initialize).toHaveBeenCalledOnce();
		expect(harness.relay.flushSubscribers).toHaveBeenCalledOnce();
		expect(harness.close).toHaveBeenCalledOnce();
		expect(harness.order).toEqual(["flush", "close"]);
	});

	it("keeps the shared host alive when one owner releases during another owner's run", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const first = manager.acquire();
		const second = manager.acquire();
		const runGate = deferred();
		const runStarted = deferred();
		const running = second.observeRun(runContext, async () => {
			runStarted.resolve();
			await runGate.promise;
			return agentResult();
		});
		await runStarted.promise;

		await first.release();
		expect(harness.order).toEqual([]);
		const finalRelease = second.release();
		await Promise.resolve();
		expect(harness.order).toEqual([]);
		runGate.resolve();
		await running;
		await finalRelease;

		expect(harness.relay.flushSubscribers).toHaveBeenCalledOnce();
		expect(harness.close).toHaveBeenCalledOnce();
		expect(harness.order).toEqual(["flush", "close"]);
	});

	it("bounds shutdown around a wedged accepted run and retries the retained activation", async () => {
		vi.useFakeTimers();
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		const runGate = deferred();
		const runStarted = deferred();
		const running = owner.observeRun(runContext, async () => {
			runStarted.resolve();
			await runGate.promise;
			return agentResult();
		});
		await runStarted.promise;

		const firstRelease = owner.release();
		await vi.advanceTimersByTimeAsync(5_000);
		await firstRelease;
		expect(harness.relay.flushSubscribers).not.toHaveBeenCalled();
		expect(harness.close).not.toHaveBeenCalled();

		const retryOwner = manager.acquire();
		runGate.resolve();
		await running;
		await retryOwner.release();

		expect(harness.initialize).toHaveBeenCalledOnce();
		expect(harness.relay.flushSubscribers).toHaveBeenCalledOnce();
		expect(harness.close).toHaveBeenCalledOnce();
		expect(harness.violations).toEqual([]);
	});

	it.each([
		"subscriber flush",
		"activation close",
	] as const)("bounds a wedged %s and retries the retained activation", async (step) => {
		vi.useFakeTimers();
		const harness = createRelayHarness({ configured: true });
		const neverSettles = new Promise<void>(() => undefined);
		if (step === "subscriber flush") {
			harness.relay.flushSubscribers.mockImplementationOnce(
				async () => neverSettles,
			);
		} else {
			harness.close.mockImplementationOnce(async () => neverSettles);
		}
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		expect(await owner.state()).toBe("active");

		const firstRelease = owner.release();
		await vi.advanceTimersByTimeAsync(5_000);
		await firstRelease;

		const retryOwner = manager.acquire();
		await retryOwner.release();

		expect(harness.initialize).toHaveBeenCalledOnce();
		expect(harness.relay.flushSubscribers).toHaveBeenCalledTimes(2);
		expect(harness.close).toHaveBeenCalledTimes(
			step === "subscriber flush" ? 1 : 2,
		);
	});
});
