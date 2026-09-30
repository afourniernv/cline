import type { RelayJson } from "./contracts";

export const MAX_EVENT_JSON_CHARS = 256 * 1024;
export const MAX_TEXT_CHARS = 64 * 1024;
export const MAX_PROJECTION_DEPTH = 16;
export const MAX_COLLECTION_ITEMS = 256;
export const MAX_KEY_CHARS = 512;
export const MAX_METADATA_ID_CHARS = 256;

interface ProjectionBudget {
	remaining: number;
	truncated: boolean;
	unsupported: boolean;
	seen: WeakSet<object>;
}

function takeProjectedText(
	value: string,
	budget: ProjectionBudget,
	limit = MAX_TEXT_CHARS,
): string {
	const available = Math.max(0, Math.min(limit, budget.remaining));
	const projected = value.slice(0, available);
	budget.remaining -= projected.length;
	if (projected.length < value.length) budget.truncated = true;
	return projected;
}

function projectValue(
	value: unknown,
	budget: ProjectionBudget,
	depth: number,
): RelayJson {
	if (value === null) return null;
	switch (typeof value) {
		case "boolean":
			return value;
		case "number":
			return Number.isFinite(value) ? value : String(value);
		case "string":
			return takeProjectedText(value, budget);
		case "bigint":
			return takeProjectedText(value.toString(), budget);
		case "undefined":
		case "function":
		case "symbol":
			return null;
	}

	if (value instanceof Error) return { error: true };
	if (value instanceof Date)
		return takeProjectedText(value.toISOString(), budget);
	if (value instanceof Uint8Array) {
		return { binary: true, bytes: value.byteLength };
	}
	const prototype = Object.getPrototypeOf(value);
	if (
		!Array.isArray(value) &&
		prototype !== Object.prototype &&
		prototype !== null
	) {
		budget.unsupported = true;
		return { omitted: true, reason: "unsupported_object" };
	}
	if (depth >= MAX_PROJECTION_DEPTH || budget.remaining <= 0) {
		budget.truncated = true;
		return { truncated: true };
	}
	if (budget.seen.has(value)) {
		budget.truncated = true;
		return { circular: true };
	}
	budget.seen.add(value);

	if (Array.isArray(value)) {
		const result: RelayJson[] = [];
		const count = Math.min(value.length, MAX_COLLECTION_ITEMS);
		for (let index = 0; index < count && budget.remaining > 0; index += 1) {
			budget.remaining = Math.max(0, budget.remaining - 2);
			const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
			if (!descriptor || !("value" in descriptor)) {
				budget.unsupported = true;
				result.push({ omitted: true, reason: "accessor" });
				continue;
			}
			result.push(projectValue(descriptor.value, budget, depth + 1));
		}
		if (count < value.length || result.length < count) budget.truncated = true;
		budget.seen.delete(value);
		return result;
	}

	const result: Record<string, RelayJson> = Object.create(null) as Record<
		string,
		RelayJson
	>;
	let count = 0;
	for (const rawKey in value) {
		const descriptor = Object.getOwnPropertyDescriptor(value, rawKey);
		if (!descriptor?.enumerable) continue;
		if (count >= MAX_COLLECTION_ITEMS || budget.remaining <= 0) {
			budget.truncated = true;
			break;
		}
		count += 1;
		const key = takeProjectedText(rawKey, budget, MAX_KEY_CHARS);
		budget.remaining = Math.max(0, budget.remaining - 4);
		if (!("value" in descriptor)) {
			budget.unsupported = true;
			result[key] = { omitted: true, reason: "accessor" };
			continue;
		}
		result[key] = projectValue(descriptor.value, budget, depth + 1);
	}
	budget.seen.delete(value);
	return result;
}

export function projectJson(value: unknown): {
	value: RelayJson;
	omissionReason?:
		| "payload_truncated"
		| "projection_failed"
		| "unsupported_value";
} {
	try {
		const budget: ProjectionBudget = {
			remaining: MAX_EVENT_JSON_CHARS,
			truncated: false,
			unsupported: false,
			seen: new WeakSet(),
		};
		const projected = projectValue(value, budget, 0);
		const serialized = JSON.stringify(projected);
		if (serialized.length <= MAX_EVENT_JSON_CHARS) {
			return {
				value: JSON.parse(serialized) as RelayJson,
				...(budget.truncated
					? { omissionReason: "payload_truncated" as const }
					: budget.unsupported
						? { omissionReason: "unsupported_value" as const }
						: {}),
			};
		}
		return {
			value: {
				truncated: true,
				preview: serialized.slice(0, MAX_TEXT_CHARS),
			},
			omissionReason: "payload_truncated",
		};
	} catch {
		return {
			value: { omitted: true, reason: "projection_failed" },
			omissionReason: "projection_failed",
		};
	}
}

export function boundedText(
	current: string,
	next: string,
): { text: string; truncated: boolean } {
	if (current.length >= MAX_TEXT_CHARS) {
		return { text: current, truncated: next.length > 0 };
	}
	const remaining = MAX_TEXT_CHARS - current.length;
	return {
		text: current + next.slice(0, remaining),
		truncated: next.length > remaining,
	};
}

export function boundedMetadataId(value: string): string {
	return value.slice(0, MAX_METADATA_ID_CHARS);
}
