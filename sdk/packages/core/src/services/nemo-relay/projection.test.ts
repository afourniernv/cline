import { describe, expect, it } from "vitest";
import { projectJson } from "./projection";
import { NemoRelayRuntimeManager } from "./runtime";
import { agentResult, createRelayHarness, runContext } from "./test-support";

describe("NemoRelay observable payload projection", () => {
	it("preserves __proto__ as data without changing the projected prototype", () => {
		const source = JSON.parse('{"__proto__":{"polluted":true},"ok":true}');
		const projected = projectJson(source);
		const value = projected.value as Record<string, unknown>;

		expect(Object.hasOwn(value, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({
			polluted: true,
		});
		expect(value.ok).toBe(true);
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
		expect(projected.omissionReason).toBeUndefined();
	});

	it("never lets hostile projected values change model or tool behavior", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		const invalidDate = new Date(Number.NaN);
		const output = new Proxy(
			{ ok: true },
			{
				ownKeys: () => {
					throw new Error("projection canary");
				},
			},
		);
		let providerRequest: unknown;

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const model = instrumentation.wrapModel(
				{
					async *stream(request) {
						providerRequest = request;
						yield { type: "finish", reason: "stop" };
					},
				},
				"provider",
				"model",
			);
			const request = {
				messages: [],
				tools: [],
				options: { invalidDate },
			};
			for await (const _event of await model.stream(request)) {
				// Consume the physical stream.
			}
			expect(providerRequest).toBe(request);

			const [tool] = instrumentation.wrapTools([
				{
					name: "proxy-output",
					description: "test",
					inputSchema: {},
					execute: () => output,
				},
			]);
			await expect(
				tool.execute(
					{ invalidDate },
					{ agentId: "agent", iteration: 1, toolCallId: "call" },
				),
			).resolves.toBe(output);
			return agentResult();
		});

		expect(JSON.stringify(harness.toolEnds)).toContain("projection_failed");
		await owner.release();
	});

	it("does not invoke accessors while copying observable payloads", async () => {
		const harness = createRelayHarness({ configured: true });
		const manager = new NemoRelayRuntimeManager({
			load: async () => harness.modules,
		});
		const owner = manager.acquire();
		let getterReads = 0;
		const payload = Object.defineProperty({ visible: true }, "secret", {
			enumerable: true,
			get() {
				getterReads += 1;
				return "do-not-read";
			},
		});

		await owner.observeRun(runContext, async (instrumentation) => {
			if (!instrumentation) throw new Error("expected Relay instrumentation");
			const [tool] = instrumentation.wrapTools([
				{
					name: "accessor-input",
					description: "test",
					inputSchema: {},
					execute: (input) => input,
				},
			]);
			await expect(
				tool.execute(payload, {
					agentId: "agent",
					iteration: 1,
					toolCallId: "call",
				}),
			).resolves.toBe(payload);
			return agentResult();
		});

		expect(getterReads).toBe(0);
		expect(JSON.stringify(harness.toolStarts)).toContain("unsupported_value");
		await owner.release();
	});
});
