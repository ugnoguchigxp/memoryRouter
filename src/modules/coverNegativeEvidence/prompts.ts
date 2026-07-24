export function buildNegativeEvidenceUserPrompt(params: {
  title: string;
  content: string;
}) {
  return JSON.stringify({
    candidate: {
      title: params.title,
      content: params.content,
    },
  });
}
