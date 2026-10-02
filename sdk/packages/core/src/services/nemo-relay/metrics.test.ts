import { describe, expect, it, vi } from "vitest";
import type { RelayMeasurement, RelayModule } from "./contracts";
import { RunMetrics } from "./metrics";
import { runContext } from "./test-support";

type MetricEvent = { name: string; measurements: RelayMeasurement[] };

function createMetrics() {
	const events: MetricEvent[] = [];
	const onFailure = vi.fn();
	const relay = {
		MetricKind: { Counter: 0, UpDownCounter: 1, Histogram: 3 },
		MetricValueType: { U64: 0, I64: 1, F64: 2 },
		metric: vi.fn((name: string, measurements: RelayMeasurement[]) => {
			events.push({ name, measurements });
		}),
	} as unknown as RelayModule;
	return {
		events,
		onFailure,
		relay,
		metrics: new RunMetrics(relay, {}, runContext, onFailure),
	};
}

describe("RunMetrics model measurements", () => {
	it("emits bounded reliability and usage dimensions", () => {
		const { events, metrics } = createMetrics();
		metrics.modelStarted();
		metrics.modelCompleted({
			outcome: "failed",
			durationMs: 1_500,
			timeToFirstEventMs: 250,
			usage: {
				inputTokens: 3,
				outputTokens: 2,
				cacheReadTokens: 1,
				reasoningTokenCount: 4,
				totalCost: 0.25,
			},
			toolCallCount: 2,
			errorClass: "auth",
			errorRetryable: false,
		});

		const completed = events.find(
			({ name }) => name === "cline.agent.model.completed",
		);
		expect(completed?.name).toBe("cline.agent.model.completed");
		expect(completed?.measurements.map(({ name }) => name)).toEqual([
			"cline.agent.model.calls",
			"cline.agent.model.duration",
			"cline.agent.model.time_to_first_event",
			"cline.agent.model.tokens",
			"cline.agent.model.tokens",
			"cline.agent.model.tokens",
			"cline.agent.model.tokens",
			"cline.agent.model.cost",
			"cline.agent.model.tool_calls",
		]);
		expect(completed?.measurements[0]?.attributes).toMatchObject({
			surface: "cli",
			outcome: "failed",
			error_class: "auth",
			error_retryable: false,
		});
		expect(
			events
				.filter(({ name }) => name === "cline.agent.model.active")
				.flatMap(({ measurements }) => measurements.map(({ value }) => value)),
		).toEqual([1, -1]);
	});

	it("omits invalid counters", () => {
		const { events, metrics } = createMetrics();
		metrics.modelCompleted({
			outcome: "completed",
			durationMs: -1,
			usage: { inputTokens: Number.NaN, outputTokens: -1, totalCost: -0.1 },
			toolCallCount: Number.MAX_SAFE_INTEGER + 1,
		});
		const completed = events.find(
			({ name }) => name === "cline.agent.model.completed",
		);
		expect(completed?.measurements.map(({ name }) => name)).toEqual([
			"cline.agent.model.calls",
			"cline.agent.model.duration",
		]);
	});

	it("contains exporter failures", () => {
		const { metrics, onFailure, relay } = createMetrics();
		vi.mocked(relay.metric).mockImplementation(() => {
			throw new Error("export failed");
		});
		expect(() =>
			metrics.modelCompleted({
				outcome: "completed",
				durationMs: 1,
				toolCallCount: 0,
			}),
		).not.toThrow();
		expect(onFailure).toHaveBeenCalledTimes(2);
	});
});

describe("RunMetrics tool measurements", () => {
	it("tracks concurrent activity and bounded outcomes", () => {
		const { events, metrics } = createMetrics();
		metrics.toolStarted();
		metrics.toolStarted();
		metrics.toolCompleted("threw", 2_000);
		metrics.toolCompleted("returned", 500);

		expect(
			events
				.filter(({ name }) => name === "cline.agent.tool.active")
				.flatMap(({ measurements }) => measurements.map(({ value }) => value)),
		).toEqual([1, 1, -1, -1]);
		expect(
			events.find(({ name }) => name === "cline.agent.tool.completed")
				?.measurements[0]?.attributes,
		).toMatchObject({ callback_outcome: "threw" });
	});
});

describe("RunMetrics coverage measurements", () => {
	it("records bounded omission dimensions", () => {
		const { events, metrics } = createMetrics();
		metrics.omission("tool", "payload_truncated");
		expect(events[0]).toMatchObject({
			name: "cline.agent.observation.omitted",
			measurements: [
				{
					name: "cline.agent.observation.omissions",
					value: 1,
					attributes: {
						operation: "tool",
						reason: "payload_truncated",
					},
				},
			],
		});
	});
});

describe("RunMetrics run measurements", () => {
	it("rolls up run concurrency, model usage, and tool callbacks", () => {
		const { events, metrics } = createMetrics();
		metrics.runStarted();
		metrics.modelStarted();
		metrics.modelCompleted({
			outcome: "completed",
			durationMs: 1,
			usage: { inputTokens: 3, outputTokens: 2, totalCost: 0.25 },
			toolCallCount: 0,
		});
		metrics.modelStarted();
		metrics.modelCompleted({
			outcome: "completed",
			durationMs: 1,
			usage: { inputTokens: 2, outputTokens: 4, totalCost: 0.5 },
			toolCallCount: 0,
		});
		metrics.toolStarted();
		metrics.toolStarted();
		metrics.toolCompleted("returned", 1);
		metrics.toolCompleted("threw", 1);
		metrics.runCompleted({
			outcome: "completed",
			durationMs: 3_000,
			iterations: 2,
		});

		const run = events.find(({ name }) => name === "cline.agent.run.completed");
		expect(run?.measurements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "cline.agent.run.model_calls",
					value: 2,
				}),
				expect.objectContaining({
					name: "cline.agent.run.peak_active_tools",
					value: 2,
				}),
				expect.objectContaining({
					name: "cline.agent.run.tool_executions",
					value: 2,
				}),
				expect.objectContaining({
					name: "cline.agent.run.tool_callback_failures",
					value: 1,
				}),
				expect.objectContaining({
					name: "cline.agent.run.tokens",
					value: 5,
					attributes: expect.objectContaining({ token_type: "input" }),
				}),
				expect.objectContaining({
					name: "cline.agent.run.tokens",
					value: 6,
					attributes: expect.objectContaining({ token_type: "output" }),
				}),
				expect.objectContaining({
					name: "cline.agent.run.cost",
					value: 0.75,
				}),
			]),
		);
		expect(
			events
				.filter(({ name }) => name === "cline.agent.run.active")
				.flatMap(({ measurements }) => measurements.map(({ value }) => value)),
		).toEqual([1, -1]);
		expect(run?.measurements[0]?.attributes).toMatchObject({
			outcome: "completed",
		});
	});
});
