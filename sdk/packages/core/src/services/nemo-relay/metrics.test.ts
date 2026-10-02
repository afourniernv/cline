import { describe, expect, it, vi } from "vitest";
import type { RelayMeasurement, RelayModule } from "./contracts";
import { RunMetrics } from "./metrics";
import { runContext } from "./test-support";

type MetricEvent = { name: string; measurements: RelayMeasurement[] };

function createMetrics() {
	const events: MetricEvent[] = [];
	const onFailure = vi.fn();
	const relay = {
		MetricKind: { Counter: 0, Histogram: 3 },
		MetricValueType: { U64: 0, F64: 2 },
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
