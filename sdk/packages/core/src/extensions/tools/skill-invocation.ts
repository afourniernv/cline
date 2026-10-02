import type { AgentToolContext } from "@cline/shared";
import type { SkillsExecutorWithMetadata } from "./types";

export type SkillInvocationOutcome =
	| "resolved"
	| "not_found"
	| "disabled"
	| "ambiguous"
	| "already_running"
	| "unclassified"
	| "failed";

export type SkillInvocationSource = "standalone" | "agent_plugin";

export interface SkillInvocationObservation {
	outcome: SkillInvocationOutcome;
	source?: SkillInvocationSource;
}

export interface ObservedSkillInvocation {
	output: string;
	observation?: SkillInvocationObservation;
}

export type ObservedSkillsExecutor = (
	skill: string,
	args: string | undefined,
	context: AgentToolContext,
) => Promise<ObservedSkillInvocation>;

const observedExecutors = new WeakMap<
	SkillsExecutorWithMetadata,
	ObservedSkillsExecutor
>();

const observedTools = new WeakMap<
	object,
	{
		availableSkills: () => number | undefined;
		observations: WeakMap<AgentToolContext, SkillInvocationObservation[]>;
	}
>();

export function registerObservedSkillsExecutor(
	executor: SkillsExecutorWithMetadata,
	observed: ObservedSkillsExecutor,
): void {
	observedExecutors.set(executor, observed);
}

export async function executeSkillsWithObservation(
	executor: SkillsExecutorWithMetadata,
	skill: string,
	args: string | undefined,
	context: AgentToolContext,
): Promise<ObservedSkillInvocation> {
	const observed = observedExecutors.get(executor);
	return observed
		? observed(skill, args, context)
		: {
				output: await executor(skill, args, context),
				observation: { outcome: "unclassified" },
			};
}

export function registerObservedSkillsTool(
	tool: object,
	availableSkills: () => number | undefined,
	observations: WeakMap<AgentToolContext, SkillInvocationObservation[]>,
): void {
	observedTools.set(tool, { availableSkills, observations });
}

export function availableSkillsForTool(tool: object): number | undefined {
	return observedTools.get(tool)?.availableSkills();
}

export function takeSkillInvocationObservation(
	tool: object,
	context: AgentToolContext,
): SkillInvocationObservation | undefined {
	const observations = observedTools.get(tool)?.observations;
	const pending = observations?.get(context);
	const observation = pending?.shift();
	if (pending?.length === 0) observations?.delete(context);
	return observation;
}
