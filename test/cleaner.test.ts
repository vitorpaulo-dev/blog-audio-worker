import { describe, expect, it } from "vitest";
import { cleanForNarration } from "../src/cleaner.js";

describe("cleanForNarration", () => {
  it("removes fenced code blocks entirely so code is not read aloud", () => {
    const dirty = "Intro text.\n\n```java\npublic final void run() {}\n```\n\nOutro.";
    expect(cleanForNarration(dirty)).toBe("Intro text.\n\nOutro.");
  });

  it("removes inline code and tildes", () => {
    expect(cleanForNarration("Use `render()` here")).toBe("Use here");
  });

  it("strips headings, list markers, links and bold", () => {
    const dirty = "## Setup\n\n- **first** item\n\n1. numbered item\n\n[link text](http://a.b)\n";
    const clean = cleanForNarration(dirty);
    expect(clean).toContain("Setup");
    expect(clean).toContain("first item");
    expect(clean).toContain("numbered item");
    expect(clean).toContain("link text");
    expect(clean).not.toContain("[");
    expect(clean).not.toContain("http");
  });

  it("removes bare urls", () => {
    expect(cleanForNarration("docs at https://example.com/x")).toBe("docs at");
  });
});
