import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentResult } from "@cline/shared";
import { vi } from "vitest";
import type { NemoRelayRunContext, RelayModules } from "./contracts";

type HarnessScopeFrame = { handle: object };

type HarnessScopeStack = {
	frames: HarnessScopeFrame[];
};

type HarnessPropagationContext = {
	traceparent: string;
	parentHandle: object | null;
};

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
	const stackStorage = new AsyncLocalStorage<HarnessScopeStack>();
	const stacks: HarnessScopeStack[] = [];
	const scopeOwners = new WeakMap<object, HarnessScopeStack>();
	const callOwners = new WeakMap<object, HarnessScopeStack>();
	const pushed: Array<{ name: string; handle: object }> = [];
	const popped: Array<{ handle: object; output: unknown; metadata: unknown }> =
		[];
	const metrics: Array<{ name: string; measurements: unknown[] }> = [];
	const llmStarts: unknown[][] = [];
	const llmEnds: unknown[][] = [];
	const toolStarts: unknown[][] = [];
	const toolEnds: unknown[][] = [];
	const failStrictly = (message: string): never => {
		throw new Error(message);
	};
	const activeStackFor = (operation: string): HarnessScopeStack =>
		stackStorage.getStore() ??
		failStrictly(`${operation} ran without an active Relay scope stack`);
	const validateHandleOwner = (
		operation: string,
		handle: object | null | undefined,
		owners: WeakMap<object, HarnessScopeStack>,
	): HarnessScopeStack | undefined => {
		const active = stackStorage.getStore();
		if (!handle) return active;
		const owner = owners.get(handle);
		if (!owner) failStrictly(`${operation} received an unknown handle`);
		if (!active) {
			failStrictly(`${operation} ran without an active Relay scope stack`);
		}
		if (owner !== active) {
			failStrictly(`${operation} used a handle from another scope stack`);
		}
		return active;
	};
	const requireHandleOwner = (
		operation: string,
		handle: object,
		owners: WeakMap<object, HarnessScopeStack>,
	): HarnessScopeStack =>
		validateHandleOwner(operation, handle, owners) ??
		failStrictly(`${operation} ran without an active Relay scope stack`);
	const createStack = (): HarnessScopeStack => {
		const stack = { frames: [] };
		stacks.push(stack);
		return stack;
	};
	const close = vi.fn(async () => {
		order.push("close");
	});
	const initialize = vi.fn(async () => ({
		report: {
			config: {
				diagnostics: options.missingExplicitConfig
					? [{ code: "plugin.configuration_file_missing" }]
					: [],
			},
			dynamic_plugins: [],
			resolved_config: {
				components: options.configured ? [{ kind: "atof", enabled: true }] : [],
			},
		},
		close,
	}));
	const relay = {
		ScopeType: { Agent: 0 },
		MetricKind: { Counter: 0, UpDownCounter: 1, Histogram: 3 },
		MetricValueType: { U64: 0, I64: 1, F64: 2 },
		scopeStackActive: vi.fn(() => stackStorage.getStore() !== undefined),
		capturePropagationContext: vi.fn(
			(): HarnessPropagationContext => ({
				traceparent: "test",
				parentHandle: stackStorage.getStore()?.frames.at(-1)?.handle ?? null,
			}),
		),
		createScopeStack: vi.fn(createStack),
		createScopeStackFromPropagation: vi.fn(createStack),
		withScopeStack: vi.fn((stack: object, callback: () => unknown) =>
			stackStorage.run(stack as HarnessScopeStack, callback),
		),
		pushScope: vi.fn((name: string, ..._args: unknown[]) => {
			const stack = activeStackFor("pushScope");
			const handle = {};
			stack.frames.push({ handle });
			scopeOwners.set(handle, stack);
			pushed.push({ name, handle });
			return handle;
		}),
		popScope: vi.fn(
			(handle: object, output: unknown, _time: unknown, metadata: unknown) => {
				const stack = requireHandleOwner("popScope", handle, scopeOwners);
				if (stack.frames.at(-1)?.handle !== handle) {
					failStrictly("popScope violated per-stack LIFO ordering");
				}
				stack.frames.pop();
				popped.push({ handle, output, metadata });
			},
		),
		metric: vi.fn(
			(name: string, measurements: unknown[], handle?: object | null) => {
				validateHandleOwner("metric", handle, scopeOwners);
				metrics.push({ name, measurements });
			},
		),
		llmCall: vi.fn((...args: unknown[]) => {
			const stack = requireHandleOwner(
				"llmCall",
				args[2] as object,
				scopeOwners,
			);
			const handle = {};
			callOwners.set(handle, stack);
			llmStarts.push(args);
			return handle;
		}),
		llmCallEnd: vi.fn((...args: unknown[]) => {
			const handle = args[0] as object;
			validateHandleOwner("llmCallEnd", handle, callOwners);
			llmEnds.push(args);
		}),
		toolCall: vi.fn((...args: unknown[]) => {
			const stack = requireHandleOwner(
				"toolCall",
				args[2] as object,
				scopeOwners,
			);
			const handle = {};
			callOwners.set(handle, stack);
			toolStarts.push(args);
			return handle;
		}),
		toolCallEnd: vi.fn((...args: unknown[]) => {
			const handle = args[0] as object;
			validateHandleOwner("toolCallEnd", handle, callOwners);
			toolEnds.push(args);
		}),
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
		modules: { relay, plugin } as unknown as RelayModules,
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
