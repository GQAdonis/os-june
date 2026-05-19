import { describe, expect, it } from "vitest";
import { buildTranscriptFromChunks } from "@/lib/meetings/transcript";

describe("buildTranscriptFromChunks", () => {
  it("orders transcript chunks by index and prefixes source labels", () => {
    const transcript = buildTranscriptFromChunks([
      { source: "microphone", index: 2, text: "We should follow up tomorrow." },
      { source: "system", index: 1, text: "The launch date is approved." },
      { source: "microphone", index: 3, text: "" },
    ]);

    expect(transcript).toBe("System audio: The launch date is approved.\n\nMicrophone: We should follow up tomorrow.");
  });
});
