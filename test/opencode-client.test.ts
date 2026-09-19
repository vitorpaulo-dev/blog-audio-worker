import { describe, expect, it, vi } from "vitest";
import { createOpenCodeClient } from "../src/opencode.js";

function fetchSequence(responses: (Response | Error)[]) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = responses[calls.length];
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (response instanceof Error) {
      throw response;
    }
    if (!response) {
      throw new Error("fetch sequence exhausted");
    }
    return response;
  };
  return { calls, fetchImpl };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("createOpenCodeClient", () => {
  it("sends the prompt as a text part to a fresh session and returns the assistant text", async () => {
    const { calls, fetchImpl } = fetchSequence([
      jsonResponse({ id: "sess-1" }),
      jsonResponse({
        parts: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      }),
    ]);
    const client = createOpenCodeClient("http://opencode.test", { fetchImpl });
    const text = await client.prompt("write the script");
    expect(text).toBe("line one\nline two");
    expect(calls[0]?.url).toBe("http://opencode.test/session");
    expect(calls[1]?.url).toBe("http://opencode.test/session/sess-1/message");
    expect((calls[1]?.body as { parts: { text: string }[] }).parts[0]?.text).toBe("write the script");
  });

  it("attaches a bearer token when one is configured", async () => {
    const { calls, fetchImpl } = fetchSequence([
      jsonResponse({ id: "s" }),
      jsonResponse({ parts: [{ type: "text", text: "ok" }] }),
    ]);
    const client = createOpenCodeClient("http://opencode.test", { token: "tok-123", fetchImpl });
    await client.prompt("hi");
    expect(calls[0]?.headers.Authorization).toBe("Bearer tok-123");
    expect(calls[1]?.headers.Authorization).toBe("Bearer tok-123");
  });

  it("omits the Authorization header when no token is configured", async () => {
    const { calls, fetchImpl } = fetchSequence([
      jsonResponse({ id: "s" }),
      jsonResponse({ parts: [{ type: "text", text: "ok" }] }),
    ]);
    const client = createOpenCodeClient("http://opencode.test", { fetchImpl });
    await client.prompt("hi");
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it("sends a valid model string as a provider/model object in the message body", async () => {
    const { calls, fetchImpl } = fetchSequence([
      jsonResponse({ id: "s" }),
      jsonResponse({ parts: [{ type: "text", text: "ok" }] }),
    ]);
    const client = createOpenCodeClient("http://opencode.test", { model: "openai/gpt-4o-mini", fetchImpl });
    const body = await client.prompt("hi").then(() => calls[1]?.body as { model?: { providerID: string; modelID: string } });
    expect(body.model).toEqual({ providerID: "openai", modelID: "gpt-4o-mini" });
  });

  it("omits the model field when the model string is empty or whitespace", async () => {
    for (const model of ["", "   "]) {
      const { calls, fetchImpl } = fetchSequence([
        jsonResponse({ id: "s" }),
        jsonResponse({ parts: [{ type: "text", text: "ok" }] }),
      ]);
      const client = createOpenCodeClient("http://opencode.test", { model, fetchImpl });
      await client.prompt("hi");
      expect(calls[0]?.body).toEqual({ title: "blog-audio-worker" });
      expect(calls[1]?.body).toEqual({ parts: [{ type: "text", text: "hi" }] });
    }
  });

  it("omits the model field and logs opencode.modelIgnored when the model has no provider separator", async () => {
    const { calls, fetchImpl } = fetchSequence([
      jsonResponse({ id: "s" }),
      jsonResponse({ parts: [{ type: "text", text: "ok" }] }),
    ]);
    const logged: unknown[] = [];
    const logSpy = vi.spyOn(console, "warn").mockImplementation((line) => logged.push(line));
    try {
      const client = createOpenCodeClient("http://opencode.test", { model: "claude-3-5-sonnet", fetchImpl });
      await client.prompt("hi");
      expect(calls[1]?.body).toEqual({ parts: [{ type: "text", text: "hi" }] });
      expect(logged.length).toBe(1);
      const entry = JSON.parse(String(logged[0]));
      expect(entry.event).toBe("opencode.modelIgnored");
      expect(entry.model).toBe("claude-3-5-sonnet");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("throws an error including status and response body without exposing the token", async () => {
    const { fetchImpl } = fetchSequence([
      new Response(JSON.stringify({ error: "bad request token tok-123" }), { status: 400 }),
    ]);
    const client = createOpenCodeClient("http://opencode.test", { token: "tok-123", fetchImpl });
    const error = await client.prompt("hi").catch((e: Error) => e);
    expect(error.message).toContain("call failed: 400:");
    expect(error.message).toContain("bad request");
    expect(error.message).not.toContain("tok-123");
    expect(error.message.length).toBeLessThanOrEqual(320);
  });

  it("trims a trailing slash from the base url", async () => {
    const { calls, fetchImpl } = fetchSequence([
      jsonResponse({ id: "s" }),
      jsonResponse({ parts: [{ type: "text", text: "ok" }] }),
    ]);
    const client = createOpenCodeClient("http://opencode.test/", { fetchImpl });
    await client.prompt("hi");
    expect(calls[0]?.url).toBe("http://opencode.test/session");
    expect(calls[1]?.url).toBe("http://opencode.test/session/s/message");
  });

  it("throws when the session creation fails", async () => {
    const { fetchImpl } = fetchSequence([new Response("nope", { status: 500 })]);
    const client = createOpenCodeClient("http://opencode.test", { fetchImpl });
    await expect(client.prompt("hi")).rejects.toThrow("failed: 500");
  });

  it("throws when the session response has no id", async () => {
    const { fetchImpl } = fetchSequence([jsonResponse({})]);
    const client = createOpenCodeClient("http://opencode.test", { fetchImpl });
    await expect(client.prompt("hi")).rejects.toThrow("no id");
  });

  it("surfaces the fetch rejection cause chain in the thrown error", async () => {
    const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const outer = Object.assign(new Error("fetch failed"), { cause: inner });
    const { fetchImpl } = fetchSequence([outer]);
    const client = createOpenCodeClient("http://opencode.test", { fetchImpl });
    const error = await client.prompt("hi").catch((e: Error) => e);
    expect(error.name).toBe("OpenCodeNetworkError");
    expect(error.message).toContain("opencode call failed (fetch):");
    expect(error.message).toContain("Error: fetch failed");
    expect(error.message).toContain("ECONNRESET: socket hang up");
  });

  it("aborts a hung request after the configured timeout and fails as a network error", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(String(input));
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      });
    };
    const client = createOpenCodeClient("http://opencode.test", { fetchImpl, timeoutMs: 20 });
    const error = await client.prompt("hi").catch((e: unknown) => e);
    expect((error as Error).name).toBe("OpenCodeNetworkError");
    expect((error as Error).message).toContain("AbortError");
    expect(calls).toEqual(["http://opencode.test/session"]);
  });

  it("recovers with a fresh session when the prompt is called again after a timeout", async () => {
    const calls: { url: string }[] = [];
    let count = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      count += 1;
      calls.push({ url: String(input) });
      if (count === 1) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("This operation was aborted", "AbortError"));
          });
        });
      }
      if (count === 2) {
        return jsonResponse({ id: "sess-2" });
      }
      return jsonResponse({ info: { role: "assistant" }, parts: [{ type: "text", text: "script ok" }] });
    };
    const client = createOpenCodeClient("http://opencode.test", { fetchImpl, timeoutMs: 15 });
    const first = await client.prompt("hi").catch((e: Error) => e);
    expect(first.name).toBe("OpenCodeNetworkError");
    const text = await client.prompt("hi");
    expect(text).toBe("script ok");
    expect(calls.map((call) => call.url)).toEqual([
      "http://opencode.test/session",
      "http://opencode.test/session",
      "http://opencode.test/session/sess-2/message",
    ]);
  });

  it("parses the documented {info, parts} message response and never sends a stream flag", async () => {
    const { calls, fetchImpl } = fetchSequence([
      jsonResponse({ id: "sess-9" }),
      jsonResponse({
        info: { id: "msg-1", role: "assistant", text: "SHOULD NOT BE READ" },
        parts: [{ type: "text", text: "from parts only" }],
      }),
    ]);
    const client = createOpenCodeClient("http://opencode.test", { fetchImpl });
    const text = await client.prompt("hi");
    expect(text).toBe("from parts only");
    expect(calls[1]?.body).not.toHaveProperty("stream");
  });
});
