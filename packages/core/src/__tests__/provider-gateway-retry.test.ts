import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Model, Api } from "@mariozechner/pi-ai";
import {
  DEFAULT_GATEWAY_RETRY_BACKOFF_MS,
  chatCompletion,
  createLLMClient,
  resolveGatewayRetryPolicy,
  type LLMClient,
} from "../llm/provider.js";
import { LLMConfigSchema } from "../models/project.js";

const mockStreamSimple = vi.fn();

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    streamSimple: (...args: unknown[]) => mockStreamSimple(...args),
  };
});

const USAGE = {
  input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions" as Api,
    provider: "openai",
    model: "test-model",
    usage: USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
    ...extra,
  };
}

function events(list: Array<Record<string, unknown>>): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of list) yield event;
    },
  };
}

const textStream = (text: string) => events([
  { type: "text_delta", contentIndex: 0, delta: text, partial: message(text) },
  { type: "done", reason: "stop", message: message(text) },
]);

/** pi-ai surfaces an HTTP 502 from the gateway as an error event before any text. */
const gateway502Stream = () => events([
  {
    type: "error",
    reason: "error",
    error: message("", { stopReason: "error", errorMessage: "502 Upstream service temporarily unavailable" }),
  },
]);

const PI_MODEL: Model<Api> = {
  id: "test-model",
  name: "test-model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://gateway.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

function piClient(extra: Partial<LLMClient> = {}): LLMClient {
  return {
    provider: "openai",
    service: "openai",
    configSource: "env",
    apiFormat: "chat",
    stream: true,
    _piModel: PI_MODEL,
    _apiKey: "k",
    defaults: { temperature: 0.7, maxTokens: 512, thinkingBudget: 0, extra: {} },
    retry: { backoffMs: [1, 1, 1] },
    ...extra,
  };
}

/** sub2api-style custom endpoint: studio config, Responses API, InkOS's own fetch transport. */
function customResponsesClient(extra: Partial<LLMClient> = {}): LLMClient {
  return piClient({
    service: "custom",
    configSource: "studio",
    apiFormat: "responses",
    _piModel: { ...PI_MODEL, api: "openai-responses" as Api },
    ...extra,
  });
}

function http502(): Response {
  return new Response(JSON.stringify({ error: { message: "Upstream service temporarily unavailable" } }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

function responsesSse(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
  ].join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const messages = [{ role: "user" as const, content: "写下一章" }];

beforeEach(() => {
  mockStreamSimple.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveGatewayRetryPolicy", () => {
  it("defaults to 3 retries with 10s/30s/60s backoff", () => {
    expect(resolveGatewayRetryPolicy(undefined, {})).toEqual({
      maxRetries: 3,
      backoffMs: [10_000, 30_000, 60_000],
    });
    expect(DEFAULT_GATEWAY_RETRY_BACKOFF_MS).toEqual([10_000, 30_000, 60_000]);
  });

  it("reads env overrides and lets explicit config win", () => {
    const env = { INKOS_LLM_RETRY_MAX: "5", INKOS_LLM_RETRY_BACKOFF_MS: "100, 200" };
    expect(resolveGatewayRetryPolicy(undefined, env)).toEqual({ maxRetries: 5, backoffMs: [100, 200] });
    expect(resolveGatewayRetryPolicy({ maxRetries: 1, backoffMs: [7] }, env)).toEqual({ maxRetries: 1, backoffMs: [7] });
    expect(resolveGatewayRetryPolicy(undefined, { INKOS_LLM_RETRY_BACKOFF_MS: "abc" }).backoffMs)
      .toEqual([10_000, 30_000, 60_000]);
  });

  it("is accepted in inkos.json llm config and carried onto the client", () => {
    const config = LLMConfigSchema.parse({
      provider: "openai",
      baseUrl: "https://gateway.example/v1",
      model: "m",
      retry: { maxRetries: 2, backoffMs: [5000, 15000] },
    });
    expect(createLLMClient(config).retry).toEqual({ maxRetries: 2, backoffMs: [5000, 15000] });
  });
});

describe("gateway 502 retry for streaming agents", () => {
  it("retries a pi-ai 502 that arrives before any streamed text, even with onTextDelta", async () => {
    mockStreamSimple
      .mockReturnValueOnce(gateway502Stream())
      .mockReturnValueOnce(gateway502Stream())
      .mockReturnValueOnce(textStream("第一章正文"));
    const deltas: string[] = [];

    const result = await chatCompletion(piClient(), "test-model", messages, {
      onTextDelta: (text) => deltas.push(text),
    });

    expect(result.content).toBe("第一章正文");
    expect(mockStreamSimple).toHaveBeenCalledTimes(3);
    expect(deltas).toEqual(["第一章正文"]);
  });

  it("does not retry once text has been streamed to the caller", async () => {
    mockStreamSimple
      .mockReturnValueOnce(events([
        { type: "text_delta", contentIndex: 0, delta: "半截", partial: message("半截") },
        {
          type: "error",
          reason: "error",
          error: message("半截", { stopReason: "error", errorMessage: "502 Bad Gateway" }),
        },
      ]))
      .mockReturnValueOnce(textStream("不应该出现"));

    await expect(chatCompletion(piClient(), "test-model", messages, { onTextDelta: () => undefined }))
      .rejects.toThrow();
    expect(mockStreamSimple).toHaveBeenCalledTimes(1);
  });

  it("retries the custom endpoint (InkOS fetch transport) on HTTP 502 while streaming", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(http502())
      .mockResolvedValueOnce(http502())
      .mockResolvedValueOnce(responsesSse("恢复了"));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    const result = await chatCompletion(customResponsesClient(), "test-model", messages, {
      onTextDelta: (text) => deltas.push(text),
    });

    expect(result.content).toBe("恢复了");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://gateway.example/v1/responses");
    expect(deltas).toEqual(["恢复了"]);
  });

  it("gives up after the configured number of gateway retries", async () => {
    const fetchMock = vi.fn(async () => http502());
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatCompletion(customResponsesClient({ retry: { maxRetries: 2, backoffMs: [1] } }), "test-model", messages, {
      onTextDelta: () => undefined,
    })).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("waits 10s, 30s, then 60s between gateway retries by default", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(http502())
      .mockResolvedValueOnce(http502())
      .mockResolvedValueOnce(http502())
      .mockResolvedValueOnce(responsesSse("终于好了"));
    vi.stubGlobal("fetch", fetchMock);

    const pending = chatCompletion(customResponsesClient({ retry: undefined }), "test-model", messages, {
      onTextDelta: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ content: "终于好了" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("skips retries when the caller opts out (doctor probe)", async () => {
    const fetchMock = vi.fn(async () => http502());
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatCompletion(customResponsesClient(), "test-model", messages, { retry: false }))
      .rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
