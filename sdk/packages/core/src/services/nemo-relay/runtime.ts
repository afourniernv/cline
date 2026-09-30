import type { AgentResult, BasicLogger } from "@cline/shared";
import {
	type NemoRelayMode,
	type NemoRelayRunContext,
	type NemoRelayRunInstrumentation,
	type NemoRelayRunObserver,
	type NemoRelayRuntimeOwner,
	type NemoRelayState,
	type NemoRelaySurface,
	type RelayModule,
	type RelayModules,
	type RelayPluginModule,
	type RelayScopeHandle,
	relayRuntimeEnums,
} from "./contracts";
import { errorSummary, RunInstrumentation, safeLog } from "./instrumentation";

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

interface ActiveRuntime {
	modules: RelayModules;
	activation: Awaited<ReturnType<RelayPluginModule["initialize"]>>;
	state: "active" | "disabled";
	accepting: boolean;
	operations: Set<Promise<unknown>>;
}

interface InactiveRuntime {
	state: "conflict" | "failed" | "unsupported" | "unavailable";
	/** False when an activation could not be closed and must not be replaced. */
	replaceable?: boolean;
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

function classifyLoadFailure(
	error: unknown,
): "conflict" | "failed" | "unavailable" {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes(HOST_CONFLICT_MESSAGE)) return "conflict";
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
	private retainedForClose?: ActiveRuntime;
	/** Whether the preceding activation was fully closed and can be replaced. */
	private closing: Promise<boolean> = Promise.resolve(true);

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
			state: async () => {
				if (released) return "uninitialized";
				try {
					return (await this.ensureGeneration(logger)).state;
				} catch {
					return "failed";
				}
			},
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
		let generation: RuntimeGeneration;
		try {
			generation = await this.ensureGeneration(logger);
		} catch (error) {
			logState(logger, "failed", error);
			return execute();
		}
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
		const enums = relayRuntimeEnums(relay);
		let handle: RelayScopeHandle;
		try {
			handle = relay.pushScope(
				"cline.run",
				enums.ScopeType.Agent,
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

		const startedAt = performance.now();
		let result: T | undefined;
		let threw = false;
		try {
			result = await execute(
				new RunInstrumentation(relay, handle, context, logger),
			);
			return result;
		} catch (error) {
			threw = true;
			throw error;
		} finally {
			const outcome = taskOutcome(result, threw);
			try {
				relay.metric(
					"cline.agent.run.completed",
					[
						{
							name: "cline.agent.runs",
							kind: enums.MetricKind.Counter,
							valueType: enums.MetricValueType.U64,
							value: 1,
							attributes: {
								outcome,
								surface: context.surface,
								mode: context.mode,
							},
						},
						{
							name: "cline.agent.run.duration",
							kind: enums.MetricKind.Histogram,
							valueType: enums.MetricValueType.F64,
							value: Math.max(0, performance.now() - startedAt) / 1_000,
							unit: "s",
							attributes: {
								outcome,
								surface: context.surface,
								mode: context.mode,
							},
						},
					],
					handle,
				);
			} catch (error) {
				safeLog(logger, "debug", "Failed to emit NeMo Relay task metrics", {
					component: "nemo-relay",
					error: errorSummary(error),
				});
			}
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
		if (!this.generation) {
			this.generation = this.closing.then((canInitialize) =>
				canInitialize
					? this.initialize(logger)
					: {
							state: "failed",
							replaceable: false,
							blockingCode: "CLINE_RELAY_HOST_NOT_REPLACEABLE",
						},
			);
		}
		return this.generation;
	}

	private async initialize(logger?: BasicLogger): Promise<RuntimeGeneration> {
		let modules: RelayModules;
		try {
			modules = await this.load();
		} catch (error) {
			const state = classifyLoadFailure(error);
			logState(logger, state, error);
			return {
				state,
				...(state === "conflict"
					? { blockingCode: "CLINE_RELAY_HOST_CONFLICT" }
					: this.explicitPluginsToml
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
			const state = classifyLoadFailure(error);
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
			const replaceable = await this.closeRejectedActivation(
				modules,
				activation,
				logger,
				"closing Relay after configuration inspection failed",
			);
			logState(logger, "failed", error);
			return {
				state: "failed",
				replaceable,
				blockingCode: "CLINE_RELAY_CONFIGURATION_REQUIRED",
			};
		}
		if (missingExplicitConfig) {
			const replaceable = await this.closeRejectedActivation(
				modules,
				activation,
				logger,
				"closing Relay after a missing explicit configuration",
			);
			const error = new Error(
				`Selected NeMo Relay configuration could not be loaded: ${this.explicitPluginsToml}`,
			);
			logState(logger, "failed", error);
			return {
				state: "failed",
				replaceable,
				blockingCode: "CLINE_RELAY_CONFIGURATION_REQUIRED",
			};
		}

		let unsupportedKinds: string[];
		try {
			unsupportedKinds = unsupportedRegistrationKinds(modules.relay);
		} catch (error) {
			const replaceable = await this.closeRejectedActivation(
				modules,
				activation,
				logger,
				"closing Relay after registration inspection failed",
			);
			logState(logger, "unsupported", error);
			return { state: "unsupported", replaceable };
		}
		if (unsupportedKinds.length > 0) {
			const replaceable = await this.closeRejectedActivation(
				modules,
				activation,
				logger,
				"closing unsupported Relay middleware",
			);
			const error = unsupportedRegistrationError(unsupportedKinds);
			logState(logger, "unsupported", error);
			return { state: "unsupported", replaceable };
		}

		let state: ActiveRuntime["state"];
		try {
			state = isConfigured(activation.report) ? "active" : "disabled";
		} catch (error) {
			const replaceable = await this.closeRejectedActivation(
				modules,
				activation,
				logger,
				"closing Relay after configuration classification failed",
			);
			logState(logger, "failed", error);
			return {
				state: "failed",
				replaceable,
				blockingCode: "CLINE_RELAY_CONFIGURATION_UNVERIFIED",
			};
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

	private async closeRejectedActivation(
		modules: RelayModules,
		activation: ActiveRuntime["activation"],
		logger: BasicLogger | undefined,
		operation: string,
	): Promise<boolean> {
		const closed = await closeActivationWithin(activation, logger, operation);
		if (!closed) {
			this.retainedForClose = {
				modules,
				activation,
				state: "disabled",
				accepting: false,
				operations: new Set(),
			};
		}
		return closed;
	}

	private async release(logger?: BasicLogger): Promise<void> {
		this.owners = Math.max(0, this.owners - 1);
		if (this.owners !== 0 || (!this.generation && !this.retainedForClose))
			return;

		const generationPromise = this.generation;
		this.generation = undefined;
		const precedingClose = this.closing;
		this.closing = precedingClose
			.then(async () => {
				const resolvedGeneration = generationPromise
					? await generationPromise
					: undefined;
				const generation =
					this.retainedForClose ??
					(resolvedGeneration?.state === "active" ||
					resolvedGeneration?.state === "disabled"
						? resolvedGeneration
						: undefined);
				if (!generation) {
					return resolvedGeneration
						? !("replaceable" in resolvedGeneration) ||
								resolvedGeneration.replaceable !== false
						: true;
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
					return false;
				}
				let flushed = false;
				try {
					flushed = await settleWithin(
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
						return false;
					}
				} catch (error) {
					safeLog(logger, "error", "Failed to flush NeMo Relay subscribers", {
						component: "nemo-relay",
						error: errorSummary(error),
					});
				}
				try {
					const closed = await settleWithin(
						generation.activation.close(),
						SHUTDOWN_STEP_TIMEOUT_MS,
					);
					if (!closed) {
						this.retainedForClose = generation;
						safeLog(logger, "error", "Timed out closing NeMo Relay", {
							component: "nemo-relay",
						});
					}
					if (closed && this.retainedForClose === generation) {
						this.retainedForClose = undefined;
					}
					return closed;
				} catch (error) {
					this.retainedForClose = generation;
					safeLog(logger, "error", "Failed to close NeMo Relay", {
						component: "nemo-relay",
						error: errorSummary(error),
					});
					return false;
				}
			})
			.catch((error) => {
				safeLog(logger, "error", "Failed to stop NeMo Relay", {
					component: "nemo-relay",
					error: errorSummary(error),
				});
				return false;
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
	const clientPlatform =
		config.extensionContext?.client?.platform?.toLowerCase() ?? "";
	const clientIdentity = `${clientName} ${clientPlatform}`;
	const source = hostContext.source?.trim().toLowerCase();
	let surface: NemoRelaySurface = "unknown";
	if (
		hostContext.originMode === "automation" ||
		config.schedule ||
		config.extensionContext?.automation
	)
		surface = "automation";
	else if (
		source === "api" ||
		source === "cli" ||
		source === "core" ||
		source === "desktop" ||
		source === "enterprise" ||
		source === "hub" ||
		source === "ide" ||
		source === "jetbrains" ||
		source === "kanban" ||
		source === "neovim" ||
		source === "sdk" ||
		source === "vscode" ||
		source === "web"
	)
		surface = source;
	else if (clientName === "cline-jetbrains") surface = "jetbrains";
	else if (clientName === "cline-kanban") surface = "kanban";
	else if (clientName === "cline-platform") surface = "web";
	else if (clientName === "cline-acp" || clientName === "cline-cli")
		surface = "cli";
	else if (clientName === "cline-sdk") surface = "sdk";
	else if (clientName === "cline-vscode") surface = "vscode";
	else if (
		clientIdentity.includes("vscode") ||
		clientIdentity.includes("vs code")
	)
		surface = "vscode";
	else if (clientIdentity.includes("desktop")) surface = "desktop";
	else if (clientIdentity.includes("hub")) surface = "hub";
	else if (clientPlatform === "cli" || clientIdentity.includes("terminal"))
		surface = "cli";
	else if (clientIdentity.includes("sdk")) surface = "sdk";

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
