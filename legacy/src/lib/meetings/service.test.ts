import { describe, expect, it } from "vitest";
import {
  createMeetingNote,
  endMeeting,
  getMeetingNote,
  recordLiveTranscript,
  recordMeetingChunk,
  refreshMeetingInsights,
  type CreateMeetingDataClient,
  type FinalizeMeetingDataClient,
  type GetMeetingNoteDataClient,
  type RecordLiveTranscriptDataClient,
  type RecordMeetingChunkDataClient,
  type RefreshMeetingInsightsDataClient,
} from "@/lib/meetings/service";

describe("createMeetingNote", () => {
  it("creates a recording note in the workspace's first space", async () => {
    const createdNotes: unknown[] = [];
    const db = {
      space: {
        findFirst: async () => ({ id: "space-1" }),
      },
      note: {
        create: async (input: unknown) => {
          createdNotes.push(input);
          return { id: "note-1", title: "Planning meeting", status: "RECORDING" };
        },
      },
    } satisfies CreateMeetingDataClient;

    const note = await createMeetingNote(
      { title: "Planning meeting", userId: "user-1", workspaceId: "workspace-1" },
      db,
    );

    expect(note).toMatchObject({ id: "note-1", status: "RECORDING" });
    expect(createdNotes[0]).toMatchObject({
      data: {
        title: "Planning meeting",
        status: "RECORDING",
        visibility: "PRIVATE",
        summary: "# Meeting in progress\n- Transcript will update as audio is processed.",
        transcript: "",
        workspaceId: "workspace-1",
        ownerId: "user-1",
        spaceId: "space-1",
      },
    });
  });
});

describe("getMeetingNote", () => {
  it("returns the current note without writing a transcript chunk", async () => {
    const db = {
      note: {
        findFirst: async (input: unknown) => ({ id: "note-1", transcript: "", input }),
      },
    } satisfies GetMeetingNoteDataClient;

    const note = await getMeetingNote({ noteId: "note-1", workspaceId: "workspace-1" }, db);

    expect(note).toMatchObject({ id: "note-1", transcript: "" });
    expect((note as { input: unknown }).input).toMatchObject({
      where: { id: "note-1", workspaceId: "workspace-1" },
      include: { shares: true },
    });
  });
});

describe("recordMeetingChunk", () => {
  it("stores a transcribed chunk and rebuilds the note transcript", async () => {
    const writes: unknown[] = [];
    const db = {
      note: {
        findFirst: async () => ({ id: "note-1" }),
        update: async (input: unknown) => {
          writes.push(input);
          return { id: "note-1", transcript: "System audio: Approved.\n\nMicrophone: I will write the recap." };
        },
      },
      transcriptChunk: {
        upsert: async (input: unknown) => {
          writes.push(input);
          return { id: "chunk-2" };
        },
        findMany: async () => [
          { source: "system", index: 1, text: "Approved." },
          { source: "microphone", index: 2, text: "I will write the recap." },
        ],
      },
    } satisfies RecordMeetingChunkDataClient;

    const note = await recordMeetingChunk(
      {
        noteId: "note-1",
        workspaceId: "workspace-1",
        source: "microphone",
        index: 2,
        startSec: 20,
        endSec: 40,
        text: "I will write the recap.",
      },
      db,
    );

    expect(note).toMatchObject({ id: "note-1" });
    expect(writes[0]).toMatchObject({
      where: { noteId_source_index: { noteId: "note-1", source: "microphone", index: 2 } },
      create: {
        noteId: "note-1",
        source: "microphone",
        index: 2,
        startSec: 20,
        endSec: 40,
        text: "I will write the recap.",
        status: "TRANSCRIBED",
      },
    });
    expect(writes[1]).toMatchObject({
      where: { id: "note-1" },
      data: { transcript: "System audio: Approved.\n\nMicrophone: I will write the recap." },
    });
  });
});

describe("recordLiveTranscript", () => {
  it("persists confirmed live microphone transcript text on the note", async () => {
    const writes: unknown[] = [];
    const db = {
      note: {
        findFirst: async () => ({ id: "note-1" }),
        update: async (input: unknown) => {
          writes.push(input);
          return { id: "note-1", transcript: "Microphone: Hola mundo." };
        },
      },
    } satisfies RecordLiveTranscriptDataClient;

    const note = await recordLiveTranscript(
      { noteId: "note-1", workspaceId: "workspace-1", transcript: " Hola mundo. " },
      db,
    );

    expect(note).toMatchObject({ id: "note-1" });
    expect(writes[0]).toMatchObject({
      where: { id: "note-1" },
      data: { transcript: "Microphone: Hola mundo." },
    });
  });

  it("preserves source labels when live meeting transcript already includes them", async () => {
    const writes: unknown[] = [];
    const db = {
      note: {
        findFirst: async () => ({ id: "note-1" }),
        update: async (input: unknown) => {
          writes.push(input);
          return { id: "note-1", transcript: "Microphone: I will recap.\n\nSystem audio: Approved." };
        },
      },
    } satisfies RecordLiveTranscriptDataClient;

    await recordLiveTranscript(
      {
        noteId: "note-1",
        workspaceId: "workspace-1",
        transcript: " Microphone: I will recap.\n\nSystem audio: Approved. ",
      },
      db,
    );

    expect(writes[0]).toMatchObject({
      where: { id: "note-1" },
      data: { transcript: "Microphone: I will recap.\n\nSystem audio: Approved." },
    });
  });

  it("preserves bulleted live meeting source turns", async () => {
    const writes: unknown[] = [];
    const db = {
      note: {
        findFirst: async () => ({ id: "note-1" }),
        update: async (input: unknown) => {
          writes.push(input);
          return { id: "note-1", transcript: "- Microphone: I will recap.\n- System: Approved." };
        },
      },
    } satisfies RecordLiveTranscriptDataClient;

    await recordLiveTranscript(
      {
        noteId: "note-1",
        workspaceId: "workspace-1",
        transcript: " - Microphone: I will recap.\n- System: Approved. ",
      },
      db,
    );

    expect(writes[0]).toMatchObject({
      where: { id: "note-1" },
      data: { transcript: "- Microphone: I will recap.\n- System: Approved." },
    });
  });
});

describe("refreshMeetingInsights", () => {
  it("updates the note summary from the current transcript", async () => {
    const writes: unknown[] = [];
    const db = {
      note: {
        findFirst: async () => ({ id: "note-1", transcript: "Jun approved the launch." }),
        update: async (input: unknown) => {
          writes.push(input);
          return { id: "note-1", summary: "# Working Summary\n- Jun approved the launch." };
        },
      },
    } satisfies RefreshMeetingInsightsDataClient;
    const provider = {
      summarizeMeetingProgress: async () => "# Working Summary\n- Jun approved the launch.",
    };

    const note = await refreshMeetingInsights({ noteId: "note-1", workspaceId: "workspace-1" }, provider, db);

    expect(note).toMatchObject({ id: "note-1" });
    expect(writes[0]).toMatchObject({
      where: { id: "note-1" },
      data: { summary: "# Working Summary\n- Jun approved the launch." },
    });
  });
});

describe("endMeeting", () => {
  it("creates final notes and marks the note ready", async () => {
    const writes: unknown[] = [];
    const db = {
      note: {
        findFirst: async () => ({ id: "note-1", transcript: "Jun approved the launch." }),
        update: async (input: unknown) => {
          writes.push(input);
          return { id: "note-1", status: "READY", summary: "# Final Notes\n- Jun approved the launch." };
        },
      },
    } satisfies FinalizeMeetingDataClient;
    const provider = {
      finalizeMeetingNotes: async () => "# Final Notes\n- Jun approved the launch.",
    };

    const note = await endMeeting({ noteId: "note-1", workspaceId: "workspace-1" }, provider, db);

    expect(note).toMatchObject({ id: "note-1", status: "READY" });
    expect(writes[0]).toMatchObject({
      where: { id: "note-1" },
      data: { status: "READY", summary: "# Final Notes\n- Jun approved the launch." },
    });
  });

  it("passes supplemental notes as custom instructions when creating final notes", async () => {
    const db = {
      note: {
        findFirst: async () => ({ id: "note-1", transcript: "Microphone: Jun approved the launch." }),
        update: async (input: unknown) => input,
      },
    } satisfies FinalizeMeetingDataClient;
    let receivedInput: unknown;
    const provider = {
      finalizeMeetingNotes: async (input: unknown) => {
        receivedInput = input;
        return "# Final Notes";
      },
    };

    await endMeeting({ noteId: "note-1", workspaceId: "workspace-1", supplementalText: "Manual note: send recap." }, provider, db);

    expect(receivedInput).toEqual({
      transcript: "Microphone: Jun approved the launch.",
      customInstructions: "Manual note: send recap.",
    });
  });

  it("uses supplemental notes as content when no transcript chunks were captured", async () => {
    const db = {
      note: {
        findFirst: async () => ({ id: "note-1", transcript: "" }),
        update: async (input: unknown) => input,
      },
    } satisfies FinalizeMeetingDataClient;
    let receivedInput: unknown;
    const provider = {
      finalizeMeetingNotes: async (input: unknown) => {
        receivedInput = input;
        return "# Final Notes";
      },
    };

    await endMeeting({ noteId: "note-1", workspaceId: "workspace-1", supplementalText: "Manual note: send recap." }, provider, db);

    expect(receivedInput).toEqual({ transcript: "Manual note: send recap." });
  });

  it("rejects empty meetings with an actionable validation error", async () => {
    const db = {
      note: {
        findFirst: async () => ({ id: "note-1", transcript: "" }),
        update: async (input: unknown) => input,
      },
    } satisfies FinalizeMeetingDataClient;
    const provider = {
      finalizeMeetingNotes: async () => "# Final Notes",
    };

    await expect(endMeeting({ noteId: "note-1", workspaceId: "workspace-1" }, provider, db)).rejects.toThrow(
      "Record audio successfully or type a note before generating final notes.",
    );
  });
});
