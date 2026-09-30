import type { AgentResult } from "@cline/shared";
import { vi } from "vitest";
import type { NemoRelayRunContext } from "./runtime";

export const runContext: NemoRelayRunContext = {
	surface: "cli",
	mode: "act",
	isSubagent: false,
	sessionId: "session-1",
	cwd: "/workspace/project",
};

export function agentResult(
	finishReason: AgentResult["finishReason"] = "completed",
): AgentResult {
	const now = new Date();
	return {
		text: "done",
		usage: { inputTokens: 0, outputTokens: 0 },
		messages: [],
		toolCalls: [],
		iterations: 1,
		finishReason,
		model: { id: "secret-model", provider: "secret-provider" },
		startedAt: now,
		endedAt: now,
		durationMs: 0,
	};
}

export function createRelayHarness(
	options: {
		configured?: boolean;
		missingExplicitConfig?: boolean;
		registrations?: Array<{ kind: string }>;
	} = {},
) {
	const order: string[] = [];
	const stacks: object[] = [];
	const pushed: Array<{ name: string; handle: object }> = [];
	const popped: Array<{ handle: object; output: unknown; metadata: unknown }> =
		[];
	const metrics: Array<{ name: string; measurements: unknown[] }> = [];
	const llmStarts: unknown[][] = [];
	const llmEnds: unknown[][] = [];
	const toolStarts: unknown[][] = [];
	const toolEnds: unknown[][] = [];
	const close = vi.fn(async () => {
		order.push("close");
	});
	const initialize = vi.fn(async () => ({
		report: {
			config: {
				diagnostics: options.missingExplicitConfig
					? [
							{
								level: "warning",
								code: "plugin.configuration_file_missing",
								message: "missing",
							},
						]
					: [],
			},
			dynamic_plugins: [],
			config_paths: [],
			resolved_config: {
				components: options.configured ? [{ kind: "atof", enabled: true }] : [],
			},
		},
		isActive: true,
		close,
		[Symbol.asyncDispose]: close,
	}));
	const relay = {
		ScopeType: { Agent: 0 },
		MetricKind: {
			Counter: 0,
			UpDownCounter: 1,
			Gauge: 2,
			Histogram: 3,
		},
		MetricValueType: { U64: 0, I64: 1, F64: 2 },
		scopeStackActive: vi.fn(() => false),
		capturePropagationContext: vi.fn(() => ({ traceparent: "test" })),
		createScopeStack: vi.fn(() => {
			const stack = {};
			stacks.push(stack);
			return stack;
		}),
		createScopeStackFromPropagation: vi.fn(() => {
			const stack = {};
			stacks.push(stack);
			return stack;
		}),
		withScopeStack: vi.fn((_stack: object, callback: () => unknown) =>
			callback(),
		),
		pushScope: vi.fn((name: string, ..._args: unknown[]) => {
			const handle = {};
			pushed.push({ name, handle });
			return handle;
		}),
		popScope: vi.fn(
			(handle: object, output: unknown, _time: unknown, metadata: unknown) => {
				popped.push({ handle, output, metadata });
			},
		),
		metric: vi.fn((name: string, measurements: unknown[]) => {
			metrics.push({ name, measurements });
		}),
		llmCall: vi.fn((...args: unknown[]) => {
			llmStarts.push(args);
			return { kind: "llm" };
		}),
		llmCallEnd: vi.fn((...args: unknown[]) => llmEnds.push(args)),
		toolCall: vi.fn((...args: unknown[]) => {
			toolStarts.push(args);
			return { kind: "tool" };
		}),
		toolCallEnd: vi.fn((...args: unknown[]) => toolEnds.push(args)),
		listRuntimeRegistrations: vi.fn(() => options.registrations ?? []),
		flushSubscribers: vi.fn(async () => {
			order.push("flush");
		}),
	};
	const plugin = {
		defaultConfig: vi.fn(() => ({ version: 1, components: [] })),
		initialize,
	};
	return {
		modules: { relay, plugin } as never,
		initialize,
		close,
		order,
		stacks,
		pushed,
		popped,
		metrics,
		llmStarts,
		llmEnds,
		toolStarts,
		toolEnds,
		relay,
	};
}
