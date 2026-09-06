/** Preserve conditions and numerical facts beyond the first sentence. */
export function composerEvidence(content: string): { text: string; truncated: boolean } {
  const characters = Array.from(content.trim());
  const limit = 1200;
  if (characters.length <= limit) return { text: characters.join(""), truncated: false };
  const marker = "\n[... omitted ...]\n";
  const head = 900;
  return {
    text:
      characters.slice(0, head).join("") +
      marker +
      characters.slice(-(limit - head - marker.length)).join(""),
    truncated: true,
  };
}
