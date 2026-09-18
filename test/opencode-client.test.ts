import { describe, expect, it } from "vitest";
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

  it("merges the configured model into the message body", async () => {
    const { calls, fetchImpl } = fetchSequence([
      jsonResponse({ id: "s" }),
      jsonResponse({ parts: [{ type: "text", text: "ok" }] }),
    ]);
    const client = createOpenCodeClient("http://opencode.test", { model: "openai/gpt-4o-mini", fetchImpl });
    await client.prompt("hi");
    expect((calls[1]?.body as { model?: string }).model).toBe("openai/gpt-4o-mini");
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
});
