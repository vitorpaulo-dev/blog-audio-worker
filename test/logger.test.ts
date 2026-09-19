import { describe, expect, it } from "vitest";
import { sanitizeUrl } from "../src/logger.js";

describe("sanitizeUrl", () => {
  it("strips the query string so presigned signatures are never logged", () => {
    const sanitized = sanitizeUrl(
      "https://r2.example.com/post/audio/NARRATION-ENGLISH.wav?X-Amz-Signature=secret&X-Amz-Credential=other",
    );
    expect(sanitized).toBe("https://r2.example.com/post/audio/NARRATION-ENGLISH.wav");
    expect(sanitized).not.toContain("secret");
  });

  it("keeps urls without a query unchanged", () => {
    expect(sanitizeUrl("https://r2.example.com/post/audio/file.wav")).toBe(
      "https://r2.example.com/post/audio/file.wav",
    );
  });

  it("falls back for unparsable urls", () => {
    expect(sanitizeUrl("not a url")).toBe("<invalid-url>");
  });
});
