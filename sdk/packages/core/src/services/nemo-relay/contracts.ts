import type {
	AgentMode,
	AgentModel,
	AgentResult,
	AgentTool,
} from "@cline/shared";
import type { BuiltinSessionSource } from "../../types/common";

/**
 * The small Relay surface Cline consumes. Keep this structural so Relay's
 * implementation types do not leak through @cline/core's public declarations.
 */
export type RelayScopeHandle = object;
type RelayCallHandle = object;
type RelayScopeStack = object;
type RelayPropagationContext = object;

export interface RelayModule {
	ScopeType: { Agent: number };
	scopeStackActive(): boolean;
	capturePropagationContext(): RelayPropagationContext;
	createScopeStack(): RelayScopeStack;
	createScopeStackFromPropagation(
		context: RelayPropagationContext,
	): RelayScopeStack;
	withScopeStack<T>(stack: RelayScopeStack, callback: () => T): T;
	pushScope(
		name: string,
		scopeType: number,
		handle?: RelayScopeHandle | null,
		attributes?: number | null,
		data?: RelayJson | null,
		metadata?: RelayJson | null,
		input?: RelayJson | null,
		timestamp?: number | null,
	): RelayScopeHandle;
	popScope(
		handle: RelayScopeHandle,
		output?: RelayJson | null,
		timestamp?: number | null,
		metadata?: RelayJson | null,
	): void;
	llmCall(
		name: string,
		request: RelayJson,
		handle?: RelayScopeHandle | null,
		attributes?: number | null,
		data?: RelayJson | null,
		metadata?: RelayJson | null,
		modelName?: string | null,
		timestamp?: number | null,
	): RelayCallHandle;
	llmCallEnd(
		handle: RelayCallHandle,
		response: RelayJson,
		data?: RelayJson | null,
		metadata?: RelayJson | null,
		timestamp?: number | null,
	): void;
	toolCall(
		name: string,
		args: RelayJson,
		handle?: RelayScopeHandle | null,
		attributes?: number | null,
		data?: RelayJson | null,
		metadata?: RelayJson | null,
		toolCallId?: string | null,
		timestamp?: number | null,
	): RelayCallHandle;
	toolCallEnd(
		handle: RelayCallHandle,
		result: { result: RelayJson; annotation?: RelayJson },
		data?: RelayJson | null,
		metadata?: RelayJson | null,
		timestamp?: number | null,
	): void;
	listRuntimeRegistrations(): Array<{ kind: string }>;
	flushSubscribers(): Promise<void>;
}

export interface RelayPluginActivation {
	readonly report: {
		config: { diagnostics: Array<{ code: string }> };
		dynamic_plugins: Array<{ selected: boolean }>;
		resolved_config: RelayJson;
	};
	close(): Promise<void>;
}

export interface RelayPluginModule {
	defaultConfig(): { version?: number; components?: unknown[] };
	initialize(
		config: { version?: number; components?: unknown[] },
		additionalPluginsToml?: string,
	): Promise<RelayPluginActivation>;
}

export type RelayJson =
	| null
	| boolean
	| number
	| string
	| RelayJson[]
	| { [key: string]: RelayJson };

export type RelayModules = {
	relay: RelayModule;
	plugin: RelayPluginModule;
};

export type NemoRelayState =
	| "uninitialized"
	| "disabled"
	| "active"
	| "conflict"
	| "failed"
	| "unsupported"
	| "unavailable";

export type NemoRelaySurface =
	| BuiltinSessionSource
	| "automation"
	| "hub"
	| "sdk";

export type NemoRelayMode = AgentMode | "unknown";

export interface NemoRelayRunContext {
	surface: NemoRelaySurface;
	mode: NemoRelayMode;
	isSubagent: boolean;
	sessionId?: string;
	cwd?: string;
}

export interface NemoRelayRunInstrumentation {
	wrapModel(model: AgentModel, providerId: string, modelId: string): AgentModel;
	wrapTools(tools: AgentTool[]): AgentTool[];
}

export interface NemoRelayRunObserver {
	observeRun<T extends AgentResult>(
		context: NemoRelayRunContext,
		execute: (instrumentation?: NemoRelayRunInstrumentation) => Promise<T>,
	): Promise<T>;
}

export interface NemoRelayRuntimeOwner extends NemoRelayRunObserver {
	state(): Promise<NemoRelayState>;
	release(): Promise<void>;
}
