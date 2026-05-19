import { describe, expect, it } from "vitest";
import {
  applyRealtimeTranscriptEvent,
  emptyRealtimeTranscriptState,
  realtimeTranscriptStateFromText,
  realtimeTranscriptText,
} from "@/features/quick-notes/realtime-transcript";

describe("realtime transcript reducer", () => {
  it("builds live transcript text from deltas and completed turns", () => {
    let state = emptyRealtimeTranscriptState();

    state = applyRealtimeTranscriptEvent(state, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-1",
      delta: "Hola ",
    });
    state = applyRealtimeTranscriptEvent(state, {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-1",
      delta: "mundo",
    });

    expect(realtimeTranscriptText(state)).toBe("Hola mundo");

    state = applyRealtimeTranscriptEvent(state, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-1",
      transcript: "Hola mundo.",
    });
    state = applyRealtimeTranscriptEvent(state, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-2",
      transcript: "Segunda frase.",
    });

    expect(realtimeTranscriptText(state)).toBe("Hola mundo.\nSegunda frase.");
  });

  it("ignores unrelated realtime events", () => {
    const state = emptyRealtimeTranscriptState();

    expect(applyRealtimeTranscriptEvent(state, { type: "session.created" })).toEqual(state);
  });

  it("can resume from already persisted microphone transcript text", () => {
    const state = realtimeTranscriptStateFromText("Microphone: Primera parte.");

    expect(realtimeTranscriptText(state)).toBe("Primera parte.");
  });
});
