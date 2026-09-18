export function cleanForNarration(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^#{1,6}\s+(.*)$/gm, "$1")
    .replace(/^\s*[-*+]\s+(.*)$/gm, "$1")
    .replace(/^\s*\d+\.\s+(.*)$/gm, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*>\s?(.*)$/gm, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/\|/g, " ")
    .replace(/^-{3,}$|^\*{3,}$|^_{3,}$/gm, " ")
    .replace(/\[\^[^\]]*\]/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
