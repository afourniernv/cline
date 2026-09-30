import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentResult } from "@cline/shared";
import { vi } from "vitest";
import type { NemoRelayRunContext } from "./runtime";

type HarnessScopeFrame = { name: string; handle: object };

type HarnessScopeStack = {
	id: number;
	frames: HarnessScopeFrame[];
	propagatedFrom: object | null;
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
	const operations: Array<{
		kind: "push" | "pop" | "llm-start" | "llm-end" | "tool-start" | "tool-end";
		stackId: number | null;
		handle?: object;
		parent?: object | null;
		name?: string;
		metadata?: unknown;
	}> = [];
	const violations: string[] = [];
	let nextStackId = 1;
	const pushed: Array<{ name: string; handle: object }> = [];
	const popped: Array<{ handle: object; output: unknown; metadata: unknown }> =
		[];
	const llmStarts: unknown[][] = [];
	const llmEnds: unknown[][] = [];
	const toolStarts: unknown[][] = [];
	const toolEnds: unknown[][] = [];
	const failStrictly = (message: string): never => {
		violations.push(message);
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
	const createStack = (propagatedFrom: object | null): HarnessScopeStack => {
		const stack = { id: nextStackId++, frames: [], propagatedFrom };
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
		scopeStackActive: vi.fn(() => stackStorage.getStore() !== undefined),
		capturePropagationContext: vi.fn(
			(): HarnessPropagationContext => ({
				traceparent: "test",
				parentHandle: stackStorage.getStore()?.frames.at(-1)?.handle ?? null,
			}),
		),
		createScopeStack: vi.fn(() => createStack(null)),
		createScopeStackFromPropagation: vi.fn((context: object) =>
			createStack(
				(context as Partial<HarnessPropagationContext>).parentHandle ?? null,
			),
		),
		withScopeStack: vi.fn((stack: object, callback: () => unknown) =>
			stackStorage.run(stack as HarnessScopeStack, callback),
		),
		pushScope: vi.fn((name: string, ..._args: unknown[]) => {
			const stack = activeStackFor("pushScope");
			const handle = {};
			stack.frames.push({ name, handle });
			scopeOwners.set(handle, stack);
			pushed.push({ name, handle });
			operations.push({
				kind: "push",
				stackId: stack.id,
				handle,
				parent: (_args[1] as object | null | undefined) ?? null,
				name,
				metadata: _args[4],
			});
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
				operations.push({
					kind: "pop",
					stackId: stack.id,
					handle,
					metadata,
				});
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
			operations.push({
				kind: "llm-start",
				stackId: stack.id,
				handle,
				parent: (args[2] as object | null | undefined) ?? null,
				name: String(args[0]),
			});
			return handle;
		}),
		llmCallEnd: vi.fn((...args: unknown[]) => {
			const handle = args[0] as object;
			const stack = validateHandleOwner("llmCallEnd", handle, callOwners);
			llmEnds.push(args);
			operations.push({
				kind: "llm-end",
				stackId: stack?.id ?? null,
				handle,
				metadata: args[3],
			});
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
			operations.push({
				kind: "tool-start",
				stackId: stack.id,
				handle,
				parent: (args[2] as object | null | undefined) ?? null,
				name: String(args[0]),
			});
			return handle;
		}),
		toolCallEnd: vi.fn((...args: unknown[]) => {
			const handle = args[0] as object;
			const stack = validateHandleOwner("toolCallEnd", handle, callOwners);
			toolEnds.push(args);
			operations.push({
				kind: "tool-end",
				stackId: stack?.id ?? null,
				handle,
				metadata: args[3],
			});
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
		modules: { relay, plugin } as never,
		initialize,
		close,
		order,
		stacks,
		operations,
		violations,
		pushed,
		popped,
		llmStarts,
		llmEnds,
		toolStarts,
		toolEnds,
		relay,
	};
}
