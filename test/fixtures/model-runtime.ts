import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

export function modelFixture(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: crypto.randomUUID(), name: crypto.randomUUID(), api: "openai-responses", provider: "fixture",
		baseUrl: "https://model.invalid", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...overrides,
	};
}

export function assistantMessage(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
		api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
