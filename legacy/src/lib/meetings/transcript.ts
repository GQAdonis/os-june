export type TranscriptChunkInput = {
  source: string;
  index: number;
  text: string;
};

const sourceLabels: Record<string, string> = {
  microphone: "Microphone",
  system: "System audio",
};

export function buildTranscriptFromChunks(chunks: TranscriptChunkInput[]) {
  return chunks
    .filter((chunk) => chunk.text.trim())
    .toSorted((left, right) => left.index - right.index)
    .map((chunk) => `${sourceLabels[chunk.source] || "Audio"}: ${chunk.text.trim()}`)
    .join("\n\n");
}
