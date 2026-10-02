import type { AgentResult, BasicLogger } from "@cline/shared";
import { resolveClientSessionSource } from "../../session/history-origin";
import { SessionSource } from "../../types/common";
import type {
	NemoRelayMode,
	NemoRelayRunContext,
	NemoRelayRunInstrumentation,
	NemoRelayRunObserver,
	NemoRelayRuntimeOwner,
	NemoRelayState,
	NemoRelaySurface,
	RelayModule,
	RelayModules,
	RelayPluginModule,
	RelayScopeHandle,
} from "./contracts";
import { errorSummary, RunInstrumentation, safeLog } from "./instrumentation";
import { RunMetrics } from "./metrics";

export type {
	NemoRelayMode,
	NemoRelayRunContext,
	NemoRelayRunInstrumentation,
	NemoRelayRunObserver,
	NemoRelayRuntimeOwner,
	NemoRelayState,
	NemoRelaySurface,
} from "./contracts";

interface NemoRelayRuntimeManagerOptions {
	load?: () => Promise<RelayModules>;
	explicitPluginsToml?: string;
}

interface OwnedActivation {
	modules: RelayModules;
	activation: Awaited<ReturnType<RelayPluginModule["initialize"]>>;
	accepting: boolean;
	operations: Set<Promise<unknown>>;
}

interface ActiveRuntime extends OwnedActivation {
	state: "active" | "disabled";
}

interface InactiveRuntime {
	state: "conflict" | "failed" | "unsupported" | "unavailable";
	/** Refuse agent execution when continuing would bypass requested policy. */
	blockingCode?: string;
}

type RuntimeGeneration = ActiveRuntime | InactiveRuntime;

const RELAY_CONFIG_ENV = "CLINE_NEMO_RELAY_PLUGINS_TOML";
const EXPLICIT_CONFIG_MISSING = "plugin.configuration_file_missing";
const HOST_CONFLICT_MESSAGE =
	"conflict: plugin configuration is owned by an active dynamic plugin host";

const SHUTDOWN_STEP_TIMEOUT_MS = 5_000;
const MAX_CWD_CHARS = 4_096;
const UNSUPPORTED_EXECUTION_REGISTRATIONS = new Set([
	"tool_conditional_execution_guardrail",
	"tool_request_intercept",
	"tool_execution_intercept",
	"llm_conditional_execution_guardrail",
	"llm_request_intercept",
	"llm_execution_intercept",
	"llm_stream_execution_intercept",
]);
const RELAY_SURFACES = new Set<string>([
	...Object.values(SessionSource),
	"automation",
	"hub",
	"sdk",
]);

function relaySurface(value: string | undefined): NemoRelaySurface | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized && RELAY_SURFACES.has(normalized)
		? (normalized as NemoRelaySurface)
		: undefined;
}

function unsupportedRegistrationKinds(relay: RelayModule): string[] {
	return [
		...new Set(
			relay
				.listRuntimeRegistrations()
				.map((registration) => registration.kind)
				.filter((kind) => UNSUPPORTED_EXECUTION_REGISTRATIONS.has(kind)),
		),
	];
}

function unsupportedRegistrationError(kinds: string[]): Error {
	return Object.assign(
		new Error(
			`Configured NeMo Relay policy cannot be enforced by Cline's observation-only integration: ${kinds.join(", ")}`,
		),
		{ code: "CLINE_RELAY_EXECUTION_MIDDLEWARE_UNSUPPORTED" },
	);
}

function blockingRuntimeMessage(
	state: RuntimeGeneration["state"],
	code: string | undefined,
): string {
	if (state === "conflict") {
		return "NeMo Relay is already owned by another host, so Cline cannot prove that configured policy is enforced";
	}
	if (state === "unsupported") {
		return "Configured NeMo Relay policy cannot be enforced by Cline's observation-only integration";
	}
	if (code === "CLINE_RELAY_INITIALIZATION_FAILED") {
		return "NeMo Relay is installed but could not initialize; Cline will not bypass user- or system-managed policy";
	}
	if (code === "CLINE_RELAY_HOST_NOT_REPLACEABLE") {
		return "The preceding NeMo Relay host could not close safely, so Cline will not replace it";
	}
	return "The selected NeMo Relay configuration could not be activated";
}

const importOptional = (specifier: string): Promise<unknown> =>
	import(specifier);

function defaultRelayLoader(): Promise<RelayModules> {
	return Promise.all([
		importOptional("nemo-relay-node"),
		importOptional("nemo-relay-node/plugin"),
	]).then(([relay, plugin]) => ({
		relay: relay as unknown as RelayModule,
		plugin: plugin as unknown as RelayPluginModule,
	}));
}

function normalizeExplicitPath(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfigured(
	report: Awaited<ReturnType<RelayPluginModule["initialize"]>>["report"],
): boolean {
	const resolved = isRecord(report.resolved_config)
		? report.resolved_config
		: {};
	const components = Array.isArray(resolved.components)
		? resolved.components
		: [];
	const hasEnabledComponent = components.some(
		(component) =>
			isRecord(component) &&
			(component.enabled === undefined || component.enabled === true),
	);
	return (
		hasEnabledComponent ||
		report.dynamic_plugins.some((candidate) => candidate.selected)
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isHostConflict(error: unknown): boolean {
	return errorMessage(error).includes(HOST_CONFLICT_MESSAGE);
}

function classifyModuleLoadFailure(error: unknown): "failed" | "unavailable" {
	const message = errorMessage(error);
	if (
		message.includes("Cannot find package 'nemo-relay-node'") ||
		message.includes("Cannot find module 'nemo-relay-node'") ||
		message.includes("Cannot find package 'nemo-relay-node-") ||
		message.includes("Cannot find module 'nemo-relay-node-") ||
		message.includes("Failed to load native binding") ||
		message.includes("Unsupported OS") ||
		message.includes("Unsupported platform") ||
		message.includes("Unsupported architecture")
	) {
		return "unavailable";
	}
	return "failed";
}

function logState(
	logger: BasicLogger | undefined,
	state: Exclude<NemoRelayState, "uninitialized">,
	error?: unknown,
): void {
	if (state === "active") {
		safeLog(logger, "log", "NeMo Relay integration active", {
			component: "nemo-relay",
			state,
		});
		return;
	}
	if (state === "disabled") {
		safeLog(logger, "debug", "NeMo Relay found no configured components", {
			component: "nemo-relay",
			state,
		});
		return;
	}
	if (state === "unavailable") {
		safeLog(logger, "debug", "NeMo Relay is unavailable on this runtime", {
			component: "nemo-relay",
			state,
		});
		return;
	}
	if (state === "unsupported") {
		safeLog(
			logger,
			"error",
			"Cline could not establish that the active NeMo Relay configuration is observation-only; Cline will refuse the run rather than bypass policy",
			{ component: "nemo-relay", state, error: errorSummary(error) },
		);
		return;
	}
	safeLog(logger, "error", "NeMo Relay initialization failed", {
		component: "nemo-relay",
		state,
		error: errorSummary(error),
	});
}

function taskOutcome(
	result: AgentResult | undefined,
	threw: boolean,
): "completed" | "aborted" | "limited" | "failed" {
	if (threw) return "failed";
	if (result?.finishReason === "completed") return "completed";
	if (result?.finishReason === "aborted") return "aborted";
	if (
		result?.finishReason === "max_iterations" ||
		result?.finishReason === "mistake_limit"
	) {
		return "limited";
	}
	return "failed";
}

async function settleWithin(
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
		timer.unref?.();
	});
	try {
		return await Promise.race([promise.then(() => true), timedOut]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function closeActivationWithin(
	activation: Awaited<ReturnType<RelayPluginModule["initialize"]>>,
	logger: BasicLogger | undefined,
	operation: string,
): Promise<boolean> {
	try {
		const closed = await settleWithin(
			activation.close(),
			SHUTDOWN_STEP_TIMEOUT_MS,
		);
		if (!closed) {
			safeLog(
				logger,
				"error",
				`Timed out ${operation}; leaving NeMo Relay loaded`,
				{
					component: "nemo-relay",
				},
			);
		}
		return closed;
	} catch (error) {
		safeLog(logger, "error", `Failed to ${operation}`, {
			component: "nemo-relay",
			error: errorSummary(error),
		});
		return false;
	}
}

export class NemoRelayRuntimeManager {
	private readonly load: () => Promise<RelayModules>;
	private readonly explicitPluginsToml?: string;
	private owners = 0;
	private generation?: Promise<RuntimeGeneration>;
	private retainedForClose?: OwnedActivation;
	private closing: Promise<void> = Promise.resolve();

	constructor(options: NemoRelayRuntimeManagerOptions = {}) {
		this.load = options.load ?? defaultRelayLoader;
		this.explicitPluginsToml = normalizeExplicitPath(
			options.explicitPluginsToml ?? process.env[RELAY_CONFIG_ENV],
		);
	}

	acquire(logger?: BasicLogger): NemoRelayRuntimeOwner {
		this.owners += 1;
		let released = false;
		return {
			observeRun: (context, execute) =>
				released ? execute() : this.observeRun(context, execute, logger),
			state: async () =>
				released
					? "uninitialized"
					: (await this.ensureGeneration(logger)).state,
			release: async () => {
				if (released) return;
				released = true;
				await this.release(logger);
			},
		};
	}

	borrow(logger?: BasicLogger): NemoRelayRunObserver {
		return {
			observeRun: (context, execute) => {
				if (this.owners === 0) return execute();
				return this.observeRun(context, execute, logger);
			},
		};
	}

	private async observeRun<T extends AgentResult>(
		context: NemoRelayRunContext,
		execute: (instrumentation?: NemoRelayRunInstrumentation) => Promise<T>,
		logger?: BasicLogger,
	): Promise<T> {
		const generation = await this.ensureGeneration(logger);
		if (generation.state !== "active" || !generation.accepting) {
			const blockingCode =
				"blockingCode" in generation ? generation.blockingCode : undefined;
			if (generation.state === "unsupported" || blockingCode) {
				throw Object.assign(
					new Error(blockingRuntimeMessage(generation.state, blockingCode)),
					{
						code:
							blockingCode ?? "CLINE_RELAY_EXECUTION_MIDDLEWARE_UNSUPPORTED",
					},
				);
			}
			return execute();
		}

		// Registrations can be added after plugin initialization. Recheck at the
		// admission boundary so Cline never starts a run after incompatible policy
		// has appeared in the process-wide Relay registry.
		let unsupportedKinds: string[];
		try {
			unsupportedKinds = unsupportedRegistrationKinds(generation.modules.relay);
		} catch (error) {
			safeLog(
				logger,
				"error",
				"Cline could not inspect active NeMo Relay registrations; refusing the run",
				{ component: "nemo-relay", error: errorSummary(error) },
			);
			throw Object.assign(
				new Error(
					"Cline could not verify that the active NeMo Relay configuration is observation-only",
				),
				{ code: "CLINE_RELAY_CONFIGURATION_UNVERIFIED" },
			);
		}
		if (unsupportedKinds.length > 0) {
			throw unsupportedRegistrationError(unsupportedKinds);
		}

		const operation = this.observeActiveRun(
			generation,
			context,
			execute,
			logger,
		);
		generation.operations.add(operation);
		void operation.then(
			() => generation.operations.delete(operation),
			() => generation.operations.delete(operation),
		);
		return operation;
	}

	private async observeActiveRun<T extends AgentResult>(
		runtime: ActiveRuntime,
		context: NemoRelayRunContext,
		execute: (instrumentation?: NemoRelayRunInstrumentation) => Promise<T>,
		logger?: BasicLogger,
	): Promise<T> {
		const { relay } = runtime.modules;
		let stack: ReturnType<RelayModule["createScopeStack"]>;
		try {
			// Ambient async context is not, by itself, a causal relationship. Cline
			// can dispatch independent sessions and queued teammate work while another
			// run's context is still active. Only an explicitly identified subagent may
			// inherit that parent; every other run starts on an isolated root stack.
			stack =
				context.isSubagent && relay.scopeStackActive()
					? relay.createScopeStackFromPropagation(
							relay.capturePropagationContext(),
						)
					: relay.createScopeStack();
		} catch (error) {
			try {
				stack = relay.createScopeStack();
			} catch {
				safeLog(logger, "debug", "Failed to create NeMo Relay run context", {
					component: "nemo-relay",
					error: errorSummary(error),
				});
				return execute();
			}
		}

		let scopedExecution: Promise<T> | undefined;
		try {
			const wrapped = relay.withScopeStack(stack, () => {
				scopedExecution = this.observeScopedRun(
					relay,
					context,
					execute,
					logger,
				);
				return scopedExecution;
			});
			return (await wrapped) as T;
		} catch (error) {
			if (scopedExecution) return await scopedExecution;
			safeLog(logger, "debug", "Failed to enter NeMo Relay run context", {
				component: "nemo-relay",
				error: errorSummary(error),
			});
			return execute();
		}
	}

	private async observeScopedRun<T extends AgentResult>(
		relay: RelayModule,
		context: NemoRelayRunContext,
		execute: (instrumentation?: NemoRelayRunInstrumentation) => Promise<T>,
		logger?: BasicLogger,
	): Promise<T> {
		let handle: RelayScopeHandle;
		try {
			handle = relay.pushScope(
				"cline.run",
				relay.ScopeType.Agent,
				null,
				null,
				null,
				{
					"cline.surface": context.surface,
					"cline.mode": context.mode,
					"cline.is_subagent": context.isSubagent,
					...(context.sessionId
						? { "cline.session_id": context.sessionId }
						: {}),
				},
				context.cwd ? { cwd: context.cwd } : null,
			);
		} catch (error) {
			safeLog(logger, "debug", "Failed to start NeMo Relay run observation", {
				component: "nemo-relay",
				error: errorSummary(error),
			});
			return execute();
		}
		const metrics = new RunMetrics(relay, handle, context, (error) => {
			safeLog(logger, "debug", "Failed to emit NeMo Relay metric", {
				component: "nemo-relay",
				error: errorSummary(error),
			});
		});
		const startedAt = performance.now();

		let result: T | undefined;
		let threw = false;
		try {
			result = await execute(
				new RunInstrumentation(relay, handle, metrics, logger),
			);
			return result;
		} catch (error) {
			threw = true;
			throw error;
		} finally {
			const outcome = taskOutcome(result, threw);
			metrics.runCompleted({
				outcome,
				durationMs: performance.now() - startedAt,
				iterations: result?.iterations,
			});
			try {
				relay.popScope(handle, { outcome }, null, {
					...(outcome === "completed"
						? { "otel.status_code": "OK" }
						: outcome === "failed"
							? { "otel.status_code": "ERROR" }
							: {}),
				});
			} catch (error) {
				safeLog(
					logger,
					"debug",
					"Failed to finish NeMo Relay run observation",
					{
						component: "nemo-relay",
						error: errorSummary(error),
					},
				);
			}
		}
	}

	private ensureGeneration(logger?: BasicLogger): Promise<RuntimeGeneration> {
		if (this.generation) return this.generation;
		const generation = this.closing
			.then<RuntimeGeneration>(() =>
				this.retainedForClose
					? {
							state: "failed",
							blockingCode: "CLINE_RELAY_HOST_NOT_REPLACEABLE",
						}
					: this.initialize(logger),
			)
			.catch((error): RuntimeGeneration => {
				logState(logger, "failed", error);
				return {
					state: "failed",
					blockingCode: "CLINE_RELAY_INITIALIZATION_FAILED",
				};
			});
		this.generation = generation;
		return generation;
	}

	private async initialize(logger?: BasicLogger): Promise<RuntimeGeneration> {
		let modules: RelayModules;
		try {
			modules = await this.load();
		} catch (error) {
			const state = classifyModuleLoadFailure(error);
			logState(logger, state, error);
			return {
				state,
				...(this.explicitPluginsToml
					? { blockingCode: "CLINE_RELAY_CONFIGURATION_REQUIRED" }
					: state === "failed"
						? { blockingCode: "CLINE_RELAY_INITIALIZATION_FAILED" }
						: {}),
			};
		}

		let activation: Awaited<ReturnType<RelayPluginModule["initialize"]>>;
		try {
			activation = await modules.plugin.initialize(
				modules.plugin.defaultConfig(),
				this.explicitPluginsToml,
			);
		} catch (error) {
			const state = isHostConflict(error) ? "conflict" : "failed";
			logState(logger, state, error);
			return {
				state,
				...(state === "conflict"
					? { blockingCode: "CLINE_RELAY_HOST_CONFLICT" }
					: this.explicitPluginsToml
						? { blockingCode: "CLINE_RELAY_CONFIGURATION_REQUIRED" }
						: { blockingCode: "CLINE_RELAY_INITIALIZATION_FAILED" }),
			};
		}

		let missingExplicitConfig: boolean;
		try {
			missingExplicitConfig =
				this.explicitPluginsToml !== undefined &&
				activation.report.config.diagnostics.some(
					(diagnostic) => diagnostic.code === EXPLICIT_CONFIG_MISSING,
				);
		} catch (error) {
			return this.rejectActivation(
				modules,
				activation,
				logger,
				"close Relay after configuration inspection failed",
				{
					state: "failed",
					blockingCode: "CLINE_RELAY_CONFIGURATION_REQUIRED",
				},
				error,
			);
		}
		if (missingExplicitConfig) {
			const error = new Error(
				`Selected NeMo Relay configuration could not be loaded: ${this.explicitPluginsToml}`,
			);
			return this.rejectActivation(
				modules,
				activation,
				logger,
				"close Relay after a missing explicit configuration",
				{
					state: "failed",
					blockingCode: "CLINE_RELAY_CONFIGURATION_REQUIRED",
				},
				error,
			);
		}

		let unsupportedKinds: string[];
		try {
			unsupportedKinds = unsupportedRegistrationKinds(modules.relay);
		} catch (error) {
			return this.rejectActivation(
				modules,
				activation,
				logger,
				"close Relay after registration inspection failed",
				{
					state: "failed",
					blockingCode: "CLINE_RELAY_CONFIGURATION_UNVERIFIED",
				},
				error,
			);
		}
		if (unsupportedKinds.length > 0) {
			return this.rejectActivation(
				modules,
				activation,
				logger,
				"close unsupported Relay middleware",
				{ state: "unsupported" },
				unsupportedRegistrationError(unsupportedKinds),
			);
		}

		let state: ActiveRuntime["state"];
		try {
			state = isConfigured(activation.report) ? "active" : "disabled";
		} catch (error) {
			return this.rejectActivation(
				modules,
				activation,
				logger,
				"close Relay after configuration classification failed",
				{
					state: "failed",
					blockingCode: "CLINE_RELAY_CONFIGURATION_UNVERIFIED",
				},
				error,
			);
		}
		logState(logger, state);
		const runtime: ActiveRuntime = {
			modules,
			activation,
			state,
			accepting: true,
			operations: new Set(),
		};
		return runtime;
	}

	private async rejectActivation(
		modules: RelayModules,
		activation: ActiveRuntime["activation"],
		logger: BasicLogger | undefined,
		operation: string,
		failure: InactiveRuntime,
		error: unknown,
	): Promise<InactiveRuntime> {
		const closed = await closeActivationWithin(activation, logger, operation);
		if (!closed) {
			this.retainedForClose = {
				modules,
				activation,
				accepting: false,
				operations: new Set(),
			};
		}
		logState(logger, failure.state, error);
		return failure;
	}

	private async release(logger?: BasicLogger): Promise<void> {
		this.owners = Math.max(0, this.owners - 1);
		if (this.owners !== 0 || (!this.generation && !this.retainedForClose))
			return;

		const generationPromise = this.generation;
		this.generation = undefined;
		const precedingClose = this.closing;
		this.closing = precedingClose.then(async () => {
			let generation: OwnedActivation | undefined;
			try {
				const resolvedGeneration = generationPromise
					? await generationPromise
					: undefined;
				generation =
					this.retainedForClose ??
					(resolvedGeneration?.state === "active" ||
					resolvedGeneration?.state === "disabled"
						? resolvedGeneration
						: undefined);
				if (!generation) {
					return;
				}
				generation.accepting = false;
				const drained = await settleWithin(
					Promise.allSettled([...generation.operations]),
					SHUTDOWN_STEP_TIMEOUT_MS,
				);
				if (!drained) {
					this.retainedForClose = generation;
					safeLog(
						logger,
						"error",
						"Timed out waiting for active NeMo Relay runs; leaving the activation loaded",
						{ component: "nemo-relay" },
					);
					return;
				}
				try {
					const flushed = await settleWithin(
						generation.modules.relay.flushSubscribers(),
						SHUTDOWN_STEP_TIMEOUT_MS,
					);
					if (!flushed) {
						this.retainedForClose = generation;
						safeLog(
							logger,
							"error",
							"Timed out draining NeMo Relay subscribers; leaving the activation loaded",
							{ component: "nemo-relay" },
						);
						return;
					}
				} catch (error) {
					safeLog(logger, "error", "Failed to flush NeMo Relay subscribers", {
						component: "nemo-relay",
						error: errorSummary(error),
					});
				}
				const closed = await closeActivationWithin(
					generation.activation,
					logger,
					"close NeMo Relay",
				);
				if (!closed) this.retainedForClose = generation;
				else if (this.retainedForClose === generation) {
					this.retainedForClose = undefined;
				}
				return;
			} catch (error) {
				if (generation) this.retainedForClose = generation;
				safeLog(logger, "error", "Failed to stop NeMo Relay", {
					component: "nemo-relay",
					error: errorSummary(error),
				});
			}
		});
		await this.closing;
	}
}

const processRuntime = new NemoRelayRuntimeManager();

export function acquireNemoRelayRuntime(
	logger?: BasicLogger,
): NemoRelayRuntimeOwner {
	return processRuntime.acquire(logger);
}

export function borrowNemoRelayRuntime(
	logger?: BasicLogger,
): NemoRelayRunObserver {
	return processRuntime.borrow(logger);
}

export function resolveNemoRelayRunContext(
	config: Pick<
		import("@cline/shared").AgentConfig,
		"extensionContext" | "parentAgentId" | "schedule" | "sessionId"
	>,
	hostContext: {
		source?: string;
		originMode?: string;
		mode?: string;
		cwd?: string;
	} = {},
): NemoRelayRunContext {
	const clientName = config.extensionContext?.client?.name?.toLowerCase() ?? "";
	const source = relaySurface(hostContext.source);
	const clientSurface = relaySurface(
		resolveClientSessionSource(config.extensionContext?.client),
	);
	const surface: NemoRelaySurface =
		hostContext.originMode === "automation" ||
		config.schedule ||
		config.extensionContext?.automation
			? "automation"
			: (source ??
				(clientName === "cline-sdk" ? "sdk" : (clientSurface ?? "unknown")));

	const configuredMode =
		hostContext.mode ?? config.extensionContext?.workspace?.mode;
	const mode: NemoRelayMode =
		configuredMode === "act" ||
		configuredMode === "plan" ||
		configuredMode === "yolo" ||
		configuredMode === "zen"
			? configuredMode
			: "unknown";
	const sessionId =
		typeof config.sessionId === "string" &&
		/^[A-Za-z0-9._:-]{1,128}$/.test(config.sessionId)
			? config.sessionId
			: undefined;
	const effectiveCwd =
		hostContext.cwd ?? config.extensionContext?.workspace?.rootPath;
	const cwd =
		typeof effectiveCwd === "string" && effectiveCwd.length > 0
			? effectiveCwd.slice(0, MAX_CWD_CHARS)
			: undefined;
	return {
		surface,
		mode,
		isSubagent:
			Boolean(config.parentAgentId) ||
			source === "subagent" ||
			hostContext.originMode === "subagent",
		...(sessionId ? { sessionId } : {}),
		...(cwd ? { cwd } : {}),
	};
}
