import type { AgentResult } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NemoRelayRuntimeManager, resolveNemoRelayRunContext } from "./runtime";
import { agentResult, createRelayHarness, runContext } from "./test-support";

afterEach(() => vi.useRealTimers());

function managerFor(
	harness: ReturnType<typeof createRelayHarness>,
	explicitPluginsToml?: string,
): NemoRelayRuntimeManager {
	return new NemoRelayRuntimeManager({
		load: async () => harness.modules,
		explicitPluginsToml,
	});
}

describe("NemoRelayRuntimeManager", () => {
	it("shares one activation, isolates concurrent runs, and closes after the final owner", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = managerFor(harness);
		const first = manager.acquire();
		const second = manager.acquire();

		await Promise.all([
			first.observeRun(runContext, async () => agentResult()),
			second.observeRun(runContext, async () => agentResult("aborted")),
		]);

		expect(harness.initialize).toHaveBeenCalledOnce();
		expect(harness.stacks).toHaveLength(2);
		expect(new Set(harness.stacks).size).toBe(2);
		expect(harness.pushed.map(({ name }) => name)).toEqual([
			"cline.run",
			"cline.run",
		]);
		// Relay exports scope `input` as ATOF `data`; handle-local `data` is not
		// emitted on the start event.
		expect(harness.relay.pushScope.mock.calls[0]?.[4]).toBeNull();
		expect(harness.relay.pushScope.mock.calls[0]?.[6]).toEqual({
			cwd: "/workspace/project",
		});
		expect(harness.popped).toHaveLength(2);
		const abortedRun = harness.popped.find(
			(entry) =>
				(entry.output as { outcome?: string } | null)?.outcome === "aborted",
		);
		expect(abortedRun?.metadata).not.toHaveProperty("otel.status_code");

		await first.release();
		expect(harness.order).toEqual([]);
		await second.release();
		expect(harness.order).toEqual(["flush", "close"]);
	});

	it("closes once when the final owners release together", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = managerFor(harness);
		const owners = [manager.acquire(), manager.acquire()];
		await Promise.all(owners.map((owner) => owner.state()));

		await Promise.all(owners.map((owner) => owner.release()));

		expect(harness.initialize).toHaveBeenCalledOnce();
		expect(harness.relay.flushSubscribers).toHaveBeenCalledOnce();
		expect(harness.close).toHaveBeenCalledOnce();
	});

	it("does no run instrumentation when Relay has no configured components", async () => {
		const harness = createRelayHarness();
		const manager = managerFor(harness);
		const owner = manager.acquire();
		let receivedInstrumentation = true;

		await owner.observeRun(runContext, async (instrumentation) => {
			receivedInstrumentation = instrumentation !== undefined;
			return agentResult();
		});

		expect(await owner.state()).toBe("disabled");
		expect(receivedInstrumentation).toBe(false);
		expect(harness.pushed).toHaveLength(0);
		await owner.release();
		expect(harness.order).toEqual(["flush", "close"]);
	});

	it("records coarse failure state without exporting thrown error text", async () => {
		const harness = createRelayHarness({ configured: true });
		const owner = managerFor(harness).acquire();
		const canary = "SECRET_ERROR_CANARY";

		await expect(
			owner.observeRun(runContext, async () => {
				throw new Error(canary);
			}),
		).rejects.toThrow(canary);
		expect(harness.popped.at(-1)).toMatchObject({
			output: { outcome: "failed" },
			metadata: { "otel.status_code": "ERROR" },
		});
		expect(JSON.stringify(harness.popped)).not.toContain(canary);
		expect(JSON.stringify(harness.metrics)).not.toContain(canary);
		await owner.release();
	});

	it("ignores logger failures without changing the application result", async () => {
		const harness = createRelayHarness({ configured: true });
		const fail = vi.fn(() => {
			throw new Error("logger failed");
		});
		const owner = managerFor(harness).acquire({
			debug: fail,
			log: fail,
			error: fail,
		});
		harness.relay.pushScope.mockImplementationOnce(() => {
			throw new Error("observation failed");
		});

		await expect(
			owner.observeRun(runContext, async () => agentResult()),
		).resolves.toMatchObject({ finishReason: "completed" });
		expect(fail).toHaveBeenCalled();
		await owner.release();
	});

	it.each([
		"Cannot find module 'nemo-relay-node-darwin-x64' from index.js",
		"Unsupported OS: freebsd, architecture: x64",
	])("keeps an unavailable Relay platform optional: %s", async (message) => {
		const manager = new NemoRelayRuntimeManager({
			load: async () => {
				throw new Error(message);
			},
		});
		const owner = manager.acquire();
		let executed = false;

		expect(await owner.state()).toBe("unavailable");
		await owner.observeRun(runContext, async (instrumentation) => {
			expect(instrumentation).toBeUndefined();
			executed = true;
			return agentResult();
		});
		expect(executed).toBe(true);
		await owner.release();
	});

	it("does not reactivate or instrument through a released owner", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = managerFor(harness);
		const owner = manager.acquire();
		expect(await owner.state()).toBe("active");
		await owner.release();

		let executions = 0;
		await owner.observeRun(runContext, async (instrumentation) => {
			expect(instrumentation).toBeUndefined();
			executions += 1;
			return agentResult();
		});

		expect(await owner.state()).toBe("uninitialized");
		expect(executions).toBe(1);
		expect(harness.initialize).toHaveBeenCalledOnce();
		expect(harness.close).toHaveBeenCalledOnce();
	});

	it("treats a missing explicitly selected config as failed", async () => {
		const harness = createRelayHarness({ missingExplicitConfig: true });
		const manager = managerFor(harness, "/missing/plugins.toml");
		const owner = manager.acquire();

		expect(await owner.state()).toBe("failed");
		expect(harness.close).toHaveBeenCalledOnce();
		let executed = false;
		await expect(
			owner.observeRun(runContext, async () => {
				executed = true;
				return agentResult();
			}),
		).rejects.toMatchObject({
			code: "CLINE_RELAY_CONFIGURATION_REQUIRED",
		});
		expect(executed).toBe(false);
		await owner.release();
		expect(harness.relay.flushSubscribers).not.toHaveBeenCalled();
	});

	it("fails closed when another process host already owns Relay", async () => {
		const harness = createRelayHarness({ configured: true });
		harness.initialize.mockRejectedValueOnce(
			new Error(
				"conflict: plugin configuration is owned by an active dynamic plugin host",
			),
		);
		const manager = managerFor(harness);
		const owner = manager.acquire();
		let executed = false;

		expect(await owner.state()).toBe("conflict");
		await expect(
			owner.observeRun(runContext, async () => {
				executed = true;
				return agentResult();
			}),
		).rejects.toMatchObject({ code: "CLINE_RELAY_HOST_CONFLICT" });
		expect(executed).toBe(false);
		await owner.release();
	});

	it("fails closed when an explicitly selected config cannot initialize", async () => {
		const harness = createRelayHarness({ configured: true });
		harness.initialize.mockRejectedValueOnce(
			new Error("invalid plugin config"),
		);
		const manager = managerFor(harness, "/invalid/plugins.toml");
		const owner = manager.acquire();

		expect(await owner.state()).toBe("failed");
		await expect(
			owner.observeRun(runContext, async () => agentResult()),
		).rejects.toMatchObject({
			code: "CLINE_RELAY_CONFIGURATION_REQUIRED",
		});
		await owner.release();
	});

	it.each([
		"initialization failed",
		"Unsupported OS: freebsd, architecture: x64",
	])("fails closed when an installed Relay runtime cannot initialize: %s", async (message) => {
		const harness = createRelayHarness({ configured: true });
		harness.initialize.mockRejectedValueOnce(new Error(message));
		const manager = managerFor(harness);
		const owner = manager.acquire();
		await expect(
			owner.observeRun(runContext, async () => agentResult()),
		).rejects.toMatchObject({ code: "CLINE_RELAY_INITIALIZATION_FAILED" });
		await owner.release();
	});

	it("retries a retained activation before initializing a replacement", async () => {
		const harness = createRelayHarness({ missingExplicitConfig: true });
		harness.close
			.mockRejectedValueOnce(new Error("initial close failed"))
			.mockRejectedValueOnce(new Error("first retry failed"));
		const manager = managerFor(harness, "/missing/plugins.toml");

		const first = manager.acquire();
		expect(await first.state()).toBe("failed");
		await first.release();
		expect(harness.initialize).toHaveBeenCalledOnce();
		expect(harness.close).toHaveBeenCalledTimes(2);

		const second = manager.acquire();
		expect(await second.state()).toBe("failed");
		expect(harness.initialize).toHaveBeenCalledOnce();
		await second.release();

		const third = manager.acquire();
		expect(await third.state()).toBe("failed");
		expect(harness.initialize).toHaveBeenCalledTimes(2);
		await third.release();
		expect(harness.close).toHaveBeenCalledTimes(4);
	});

	it("fails closed rather than bypass configured execution middleware", async () => {
		const harness = createRelayHarness({
			configured: true,
			registrations: [{ kind: "llm_execution_intercept" }],
		});
		const manager = managerFor(harness);
		const owner = manager.acquire();

		expect(await owner.state()).toBe("unsupported");
		expect(harness.close).toHaveBeenCalledOnce();
		let executed = false;
		await expect(
			owner.observeRun(runContext, async () => {
				executed = true;
				return agentResult();
			}),
		).rejects.toMatchObject({
			code: "CLINE_RELAY_EXECUTION_MIDDLEWARE_UNSUPPORTED",
		});
		expect(executed).toBe(false);
		await owner.release();
		expect(harness.relay.flushSubscribers).not.toHaveBeenCalled();
	});

	it("fails closed when active Relay registrations cannot be inspected", async () => {
		const harness = createRelayHarness({ configured: true });
		harness.relay.listRuntimeRegistrations.mockImplementationOnce(() => {
			throw new Error("registration inspection failed");
		});
		const manager = managerFor(harness);
		const owner = manager.acquire();
		let executions = 0;

		await expect(
			owner.observeRun(runContext, async () => {
				executions += 1;
				return agentResult();
			}),
		).rejects.toMatchObject({
			code: "CLINE_RELAY_CONFIGURATION_UNVERIFIED",
		});

		expect(await owner.state()).toBe("failed");
		expect(executions).toBe(0);
		expect(harness.close).toHaveBeenCalledOnce();
		await owner.release();
	});

	it("rechecks registrations when each run is admitted", async () => {
		const harness = createRelayHarness({ configured: true });
		harness.relay.listRuntimeRegistrations
			.mockReturnValueOnce([])
			.mockReturnValue([{ kind: "llm_execution_intercept" }]);
		const manager = managerFor(harness);
		const owner = manager.acquire();

		expect(await owner.state()).toBe("active");
		await expect(
			owner.observeRun(runContext, async () => agentResult()),
		).rejects.toMatchObject({
			code: "CLINE_RELAY_EXECUTION_MIDDLEWARE_UNSUPPORTED",
		});
		expect(harness.pushed).toHaveLength(0);
		await owner.release();
	});

	it("fails closed when registrations become uninspectable after activation", async () => {
		const harness = createRelayHarness({ configured: true });
		harness.relay.listRuntimeRegistrations
			.mockReturnValueOnce([])
			.mockImplementation(() => {
				throw new Error("late registration inspection failed");
			});
		const manager = managerFor(harness);
		const owner = manager.acquire();

		expect(await owner.state()).toBe("active");
		await expect(
			owner.observeRun(runContext, async () => agentResult()),
		).rejects.toMatchObject({
			code: "CLINE_RELAY_CONFIGURATION_UNVERIFIED",
		});
		expect(harness.pushed).toHaveLength(0);
		await owner.release();
	});

	it("lets direct child runtimes borrow an active process host", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = managerFor(harness);
		const borrower = manager.borrow();

		await borrower.observeRun(runContext, async (instrumentation) => {
			expect(instrumentation).toBeUndefined();
			return agentResult();
		});
		expect(harness.initialize).not.toHaveBeenCalled();

		const owner = manager.acquire();
		await borrower.observeRun(
			{ ...runContext, isSubagent: true },
			async (instrumentation) => {
				expect(instrumentation).toBeDefined();
				return agentResult();
			},
		);
		expect(harness.initialize).toHaveBeenCalledOnce();
		expect(harness.relay.createScopeStack).toHaveBeenCalledOnce();
		await owner.release();
	});

	it("gives a borrowed child run its own propagated stack and subagent metadata", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = managerFor(harness);
		const owner = manager.acquire();
		const borrower = manager.borrow();

		await owner.observeRun(runContext, async () => {
			await borrower.observeRun({ ...runContext, isSubagent: true }, async () =>
				agentResult(),
			);
			return agentResult();
		});

		expect(harness.stacks).toHaveLength(2);
		expect(new Set(harness.stacks).size).toBe(2);
		expect(
			harness.relay.createScopeStackFromPropagation,
		).toHaveBeenCalledOnce();
		expect(harness.relay.createScopeStackFromPropagation).toHaveBeenCalledWith(
			expect.objectContaining({ parentHandle: harness.pushed[0]?.handle }),
		);
		expect(harness.relay.pushScope.mock.calls[1]?.[5]).toMatchObject({
			"cline.is_subagent": true,
		});
		await owner.release();
	});

	it("does not inherit ambient parentage for independent nested work", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = managerFor(harness);
		const owner = manager.acquire();
		const borrower = manager.borrow();

		await owner.observeRun(runContext, async () => {
			await borrower.observeRun(
				{ ...runContext, sessionId: "independent-session" },
				async () => agentResult(),
			);
			return agentResult();
		});

		expect(harness.relay.createScopeStack).toHaveBeenCalledTimes(2);
		expect(
			harness.relay.createScopeStackFromPropagation,
		).not.toHaveBeenCalled();
		expect(harness.relay.capturePropagationContext).not.toHaveBeenCalled();
		expect(new Set(harness.stacks).size).toBe(2);
		await owner.release();
	});

	it("drains concurrent subagents that outlive their parent before shutdown", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = managerFor(harness);
		const owner = manager.acquire();
		const borrower = manager.borrow();
		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		let childOne!: Promise<AgentResult>;
		let childTwo!: Promise<AgentResult>;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});

		await owner.observeRun(runContext, async () => {
			childOne = borrower.observeRun(
				{ ...runContext, sessionId: "child-one", isSubagent: true },
				async () => {
					await firstGate;
					return agentResult();
				},
			);
			childTwo = borrower.observeRun(
				{ ...runContext, sessionId: "child-two", isSubagent: true },
				async () => {
					await secondGate;
					return agentResult();
				},
			);
			return agentResult();
		});

		const releasing = owner.release();
		await Promise.resolve();
		expect(harness.order).toEqual([]);
		releaseSecond();
		await childTwo;
		await Promise.resolve();
		expect(harness.order).toEqual([]);
		releaseFirst();
		await childOne;
		await releasing;
		expect(harness.order).toEqual(["flush", "close"]);
		expect(harness.relay.createScopeStack).toHaveBeenCalledOnce();
		expect(harness.relay.createScopeStackFromPropagation).toHaveBeenCalledTimes(
			2,
		);
		expect(harness.relay.capturePropagationContext).toHaveBeenCalledTimes(2);
		expect(new Set(harness.stacks).size).toBe(3);
		expect(harness.popped.map(({ handle }) => handle)).toEqual([
			harness.pushed[0]?.handle,
			harness.pushed[2]?.handle,
			harness.pushed[1]?.handle,
		]);
	});

	it("drains an accepted run before the final flush and close", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = managerFor(harness);
		const owner = manager.acquire();
		let finishRun!: (result: AgentResult) => void;
		let enteredRun!: () => void;
		const entered = new Promise<void>((resolve) => {
			enteredRun = resolve;
		});
		const running = owner.observeRun(
			runContext,
			() =>
				new Promise<AgentResult>((resolve) => {
					finishRun = resolve;
					enteredRun();
				}),
		);
		await entered;

		const releasing = owner.release();
		await Promise.resolve();
		expect(harness.order).toEqual([]);
		finishRun(agentResult());
		await running;
		await releasing;
		expect(harness.order).toEqual(["flush", "close"]);
	});

	it("still closes after subscriber flush fails and releases idempotently", async () => {
		const harness = createRelayHarness({ configured: true });
		harness.relay.flushSubscribers.mockRejectedValueOnce(
			new Error("subscriber flush failed"),
		);
		const manager = managerFor(harness);
		const owner = manager.acquire();
		await owner.observeRun(runContext, async () => agentResult());

		await owner.release();
		await owner.release();

		expect(harness.relay.flushSubscribers).toHaveBeenCalledOnce();
		expect(harness.close).toHaveBeenCalledOnce();
	});

	it("retains a host when an accepted run outlives shutdown", async () => {
		vi.useFakeTimers();
		const harness = createRelayHarness({ configured: true });
		const manager = managerFor(harness);
		const owner = manager.acquire();
		let finishRun!: () => void;
		let runStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			runStarted = resolve;
		});
		const running = owner.observeRun(runContext, async () => {
			runStarted();
			await new Promise<void>((resolve) => {
				finishRun = resolve;
			});
			return agentResult();
		});
		await started;

		const firstRelease = owner.release();
		await vi.advanceTimersByTimeAsync(5_000);
		await firstRelease;
		expect(harness.close).not.toHaveBeenCalled();

		const retryOwner = manager.acquire();
		finishRun();
		await running;
		await retryOwner.release();
		expect(harness.order).toEqual(["flush", "close"]);
	});

	it.each([
		"subscriber flush",
		"activation close",
	] as const)("retries a retained host after a %s timeout", async (step) => {
		vi.useFakeTimers();
		const harness = createRelayHarness({ configured: true });
		const pending = new Promise<void>(() => undefined);
		if (step === "subscriber flush") {
			harness.relay.flushSubscribers.mockImplementationOnce(
				async () => pending,
			);
		} else {
			harness.close.mockImplementationOnce(async () => pending);
		}
		const manager = managerFor(harness);
		const owner = manager.acquire();
		expect(await owner.state()).toBe("active");

		const firstRelease = owner.release();
		const retryOwner = manager.acquire();
		const retryState = retryOwner.state();
		await vi.advanceTimersByTimeAsync(5_000);
		await firstRelease;
		expect(await retryState).toBe("failed");
		await retryOwner.release();

		expect(harness.initialize).toHaveBeenCalledOnce();
		expect(harness.relay.flushSubscribers).toHaveBeenCalledTimes(2);
		expect(harness.close).toHaveBeenCalledTimes(
			step === "subscriber flush" ? 1 : 2,
		);
	});

	it("does not execute a run twice when Relay fails after entering its scope stack", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = managerFor(harness);
		const owner = manager.acquire();
		let executions = 0;
		harness.relay.withScopeStack.mockImplementationOnce(
			(_stack: object, callback: () => unknown) => {
				callback();
				throw new Error("scope wrapper failed after callback admission");
			},
		);

		await expect(
			owner.observeRun(runContext, async () => {
				executions += 1;
				return agentResult();
			}),
		).resolves.toMatchObject({ finishReason: "completed" });

		expect(executions).toBe(1);
		await owner.release();
	});
});

describe("resolveNemoRelayRunContext", () => {
	it("uses normalized client, mode, automation, and subagent context", () => {
		expect(
			resolveNemoRelayRunContext({
				parentAgentId: "parent",
				extensionContext: {
					client: { name: "custom", platform: "Cline Desktop" },
					workspace: { rootPath: "/repo", mode: "yolo" },
				},
			}),
		).toEqual({
			surface: "desktop",
			mode: "yolo",
			isSubagent: true,
			cwd: "/repo",
		});

		expect(
			resolveNemoRelayRunContext(
				{
					parentAgentId: undefined,
					schedule: undefined,
				},
				{
					source: "core",
					originMode: "automation",
					mode: "plan",
				},
			),
		).toEqual({ surface: "automation", mode: "plan", isSubagent: false });

		expect(
			resolveNemoRelayRunContext(
				{ parentAgentId: undefined, schedule: undefined },
				{ source: "vscode", mode: "act" },
			),
		).toEqual({ surface: "vscode", mode: "act", isSubagent: false });

		for (const [name, surface] of [
			["cline-jetbrains", "jetbrains"],
			["PyCharm", "jetbrains"],
			["cline-kanban", "kanban"],
			["cline-acp", "cli"],
			["cline-platform", "web"],
			["cline-sdk", "sdk"],
			["Visual Studio Code", "vscode"],
			["Neovim", "neovim"],
		] as const) {
			expect(
				resolveNemoRelayRunContext({
					parentAgentId: undefined,
					schedule: undefined,
					extensionContext: { client: { name } },
				}),
			).toEqual({ surface, mode: "unknown", isSubagent: false });
		}
	});
});
