import { describe, expect, it } from "vitest";
import { cleanForNarration, cleanPodcastTurnText } from "../src/cleaner.js";

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

describe("cleanPodcastTurnText", () => {
  it("strips heading markers without eating the words", () => {
    expect(cleanPodcastTurnText("## Setup guide")).toBe("Setup guide");
    expect(cleanPodcastTurnText("###   Nested heading")).toBe("Nested heading");
  });

  it("removes fenced and inline backticks but keeps the words", () => {
    expect(cleanPodcastTurnText("Run `deploy --watch` now")).toBe("Run deploy --watch now");
    const fenced = "```ts\nlet x = 1\n```\nand then it runs";
    const cleaned = cleanPodcastTurnText(fenced);
    expect(cleaned).not.toContain("```");
    expect(cleaned).toContain("let x = 1");
    expect(cleaned).toContain("and then it runs");
  });

  it("removes bold, italic and strikethrough markers without eating the words", () => {
    expect(cleanPodcastTurnText("**bold** and *italic* and ~~gone~~")).toBe("bold and italic and gone");
    expect(cleanPodcastTurnText("__dunder__ text")).toBe("dunder text");
  });

  it("keeps apostrophes, quotes and punctuation", () => {
    expect(cleanPodcastTurnText("it's \"quoted\", isn't it?")).toBe("it's \"quoted\", isn't it?");
  });

  it("strips list, numbered and blockquote markers", () => {
    expect(cleanPodcastTurnText("- first point\n1. next one\n> noted")).toBe("first point\nnext one\nnoted");
  });

  it("collapses the whole turn to empty when only markers remain", () => {
    expect(cleanPodcastTurnText("##  ")).toBe("");
  });
});
