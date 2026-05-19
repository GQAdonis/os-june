import { describe, expect, it } from "vitest";
import { getQuickNoteCapturePlan } from "@/features/quick-notes/capture-policy";

describe("getQuickNoteCapturePlan", () => {
  it("captures quick notes from the microphone only", () => {
    expect(getQuickNoteCapturePlan()).toEqual({
      microphone: true,
      systemAudio: false,
    });
  });
});
