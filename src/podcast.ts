const HUMANIZER_RULES = [
  "You are writing a spoken podcast script, so write it as natural speech.",
  "Do not sound like a language model: avoid formulaic transitions (for example 'delve', 'it is worth noting', 'in conclusion'), avoid symmetrical sentence openings, and vary rhythm between short and long sentences.",
  "Do not clean up messy details: keep natural imperfections, opinions and asides, so it sounds like real people talking.",
  "Never use emoji, bullet lists, markdown formatting or stage directions in the spoken text.",
].join("\n");

export function podcastScriptPrompt(input: { title: string; content: string; language: string }): string {
  const languageInstruction =
    input.language === "PORTUGUESE"
      ? "Write every spoken line in Brazilian Portuguese."
      : "Write every spoken line in English.";

  const system = [
    HUMANIZER_RULES,
    "You produce podcast scripts for a software development blog.",
    languageInstruction,
  ].join("\n");

  const task = [
    "Create a two-speaker podcast episode covering the blog post below.",
    "The podcast must start with the host speaking the exact post title.",
    "Cover at least 90% of the post content: walk through every section and explain the code and concepts in words instead of reading code aloud.",
    "Alternate speakers naturally: the HOST is an energetic, curious host; the GUEST is a technical guest who explains deeply.",
    "Split long explanations across multiple turns so no single turn exceeds about 400 words.",
    "Respond with ONLY a JSON array of turns, each formatted as {\"speaker\": \"HOST\"|\"GUEST\", \"text\": \"...\"} — no prose, no markdown fences.",
    "",
    "POST TITLE:",
    input.title,
    "",
    "POST CONTENT (raw markdown):",
    input.content,
  ].join("\n");

  return `${system}\n\n${task}`;
}

export function speakerInstruct(speaker: "HOST" | "GUEST"): string {
  return speaker === "HOST"
    ? "energetic, curious podcast host, warm pacing"
    : "technical guest, calm, explanatory, precise";
}

export const PODCAST_SCRIPT_VALIDATION = {
  firstTurnSpeaker: "HOST" as const,
  minimumCoverage: 0.9,
};
