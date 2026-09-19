import { describe, expect, it } from "vitest";
import { parsePodcastScript } from "../src/opencode.js";

describe("parsePodcastScript", () => {
  it("parses a clean JSON script", () => {
    const turns = parsePodcastScript(
      `[{"speaker":"HOST","text":"Title intro"},{"speaker":"GUEST","text":"Explaining"}]`,
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]?.speaker).toBe("HOST");
  });

  it("extracts JSON wrapped in prose and code fences", () => {
    const raw = "Here is the script:\n```json\n[{\"speaker\":\"HOST\",\"text\":\"Hi\"}]\n```\nDone.";
    expect(parsePodcastScript(raw)[0]?.text).toBe("Hi");
  });

  it("rejects an invalid speaker", () => {
    expect(() => parsePodcastScript(`[{"speaker":"ROBOT","text":"Hi"}]`)).toThrow("HOST or GUEST");
  });

  it("rejects an empty turn text", () => {
    expect(() => parsePodcastScript(`[{"speaker":"HOST","text":"   "}]`)).toThrow("non-empty string");
  });

  it("rejects non-array payloads", () => {
    expect(() => parsePodcastScript(`{"speaker":"HOST"}`)).toThrow("JSON array");
  });
});
