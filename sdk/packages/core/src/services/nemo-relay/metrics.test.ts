import { describe, expect, it, vi } from "vitest";
import { DefaultToolNames } from "../../extensions/tools/constants";
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
		metrics.modelCompleted({
			outcome: "failed",
			durationMs: 1_500,
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

		const [completed] = events;
		expect(completed?.name).toBe("cline.agent.model.completed");
		expect(completed?.measurements.map(({ name }) => name)).toEqual([
			"cline.agent.model.calls",
			"cline.agent.model.duration",
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
	});

	it("omits invalid counters", () => {
		const { events, metrics } = createMetrics();
		metrics.modelCompleted({
			outcome: "completed",
			durationMs: -1,
			usage: { inputTokens: Number.NaN, outputTokens: -1, totalCost: -0.1 },
			toolCallCount: Number.MAX_SAFE_INTEGER + 1,
		});
		expect(events[0]?.measurements.map(({ name }) => name)).toEqual([
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
		expect(onFailure).toHaveBeenCalledOnce();
	});
});

describe("RunMetrics tool measurements", () => {
	it("tracks concurrent activity and bounded outcomes", () => {
		const { events, metrics } = createMetrics();
		metrics.toolStarted();
		metrics.toolStarted();
		metrics.toolCompleted("private-one", "failed", 2_000);
		metrics.toolCompleted("private-two", "completed", 500);

		expect(
			events
				.filter(({ name }) => name === "cline.agent.tool.active")
				.flatMap(({ measurements }) => measurements.map(({ value }) => value)),
		).toEqual([1, 1, -1, -1]);
		expect(
			events.find(({ name }) => name === "cline.agent.tool.completed")
				?.measurements[0]?.attributes,
		).toMatchObject({ outcome: "failed" });
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
	it("rolls up model attempts and peak tool concurrency", () => {
		const { events, metrics } = createMetrics();
		metrics.modelCompleted({
			outcome: "completed",
			durationMs: 1,
			toolCallCount: 0,
		});
		metrics.toolStarted();
		metrics.toolStarted();
		metrics.toolCompleted("one", "completed", 1);
		metrics.toolCompleted("two", "completed", 1);
		metrics.runCompleted({
			outcome: "completed",
			durationMs: 3_000,
			iterations: 2,
		});

		const run = events.find(({ name }) => name === "cline.agent.run.completed");
		expect(run?.measurements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "cline.agent.run.model_attempts",
					value: 1,
				}),
				expect.objectContaining({
					name: "cline.agent.run.peak_active_tools",
					value: 2,
				}),
			]),
		);
		expect(run?.measurements[0]?.attributes).toMatchObject({
			outcome: "completed",
		});
	});
});

describe("RunMetrics skill associations", () => {
	it("associates runs with bounded skills-tool usage", () => {
		const { events, metrics } = createMetrics();
		metrics.toolStarted();
		metrics.toolCompleted(DefaultToolNames.SKILLS, "completed", 1);
		metrics.runCompleted({ outcome: "completed", durationMs: 1 });

		const run = events.find(({ name }) => name === "cline.agent.run.completed");
		expect(run?.measurements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "cline.agent.run.skills_tool_calls",
					value: 1,
					attributes: expect.objectContaining({
						invoked_skills_tool: true,
					}),
				}),
			]),
		);
	});
});
