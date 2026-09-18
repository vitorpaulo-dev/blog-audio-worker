import { describe, expect, it } from "vitest";
import { parseAudioJobRequest } from "../src/validate.js";

const POST_ID = "d0a3f5c9-1f2b-4a1e-9b8c-7d5e3a2f1b0a";

function basePayload(): Record<string, unknown> {
  return {
    postId: POST_ID,
    postSlug: "my-post",
    contents: [
      { language: "ENGLISH", title: "My Post", content: "# Hello\n\nWorld" },
      { language: "PORTUGUESE", title: "Meu Post", content: "# Ola\n\nMundo" },
    ],
    uploads: {
      NARRATION: { ENGLISH: "http://r2/narration-en", PORTUGUESE: "http://r2/narration-pt" },
      PODCAST: { ENGLISH: "http://r2/podcast-en", PORTUGUESE: "http://r2/podcast-pt" },
    },
  };
}

describe("parseAudioJobRequest", () => {
  it("accepts the Spring contract shape", () => {
    const parsed = parseAudioJobRequest(basePayload());
    expect(parsed.postId).toBe(POST_ID);
    expect(parsed.contents).toHaveLength(2);
    expect(parsed.uploads.NARRATION?.ENGLISH).toBe("http://r2/narration-en");
    expect(parsed.uploads.PODCAST?.PORTUGUESE).toBe("http://r2/podcast-pt");
  });

  it("accepts a single-artifact payload (retry works)", () => {
    const payload = basePayload();
    payload.uploads = { NARRATION: { ENGLISH: "http://r2/narration-en" } };
    const parsed = parseAudioJobRequest(payload);
    expect(Object.entries(parsed.uploads)).toHaveLength(1);
  });

  it("rejects a non-UUID postId", () => {
    const payload = basePayload();
    payload.postId = "not-a-uuid";
    expect(() => parseAudioJobRequest(payload)).toThrow("postId must be a valid UUID");
  });

  it("rejects missing uploads", () => {
    const payload = basePayload();
    payload.uploads = {};
    expect(() => parseAudioJobRequest(payload)).toThrow("at least one upload URL");
  });

  it("rejects an invalid upload URL", () => {
    const payload = basePayload();
    payload.uploads = { NARRATION: { ENGLISH: "ftp://r2/x" } };
    expect(() => parseAudioJobRequest(payload)).toThrow("http(s) URL");
  });

  it("rejects a payload missing content for an upload language", () => {
    const payload = basePayload();
    payload.uploads = { NARRATION: { PORTUGUESE: "http://r2/narration-pt" } };
    payload.contents = [{ language: "ENGLISH", title: "T", content: "C" }];
    expect(() => parseAudioJobRequest(payload)).toThrow("No content provided for upload language PORTUGUESE");
  });

  it("rejects an invalid language", () => {
    const payload = basePayload();
    payload.contents = [{ language: "FRENCH", title: "T", content: "C" }];
    expect(() => parseAudioJobRequest(payload)).toThrow("ENGLISH or PORTUGUESE");
  });

  it("rejects a non-object body", () => {
    expect(() => parseAudioJobRequest("nope")).toThrow("JSON object");
  });
});
