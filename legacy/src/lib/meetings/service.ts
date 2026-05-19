import { prisma } from "@/lib/db";
import { getAiProvider, type FinalizeMeetingNotesInput } from "@/lib/providers/ai";
import { buildTranscriptFromChunks } from "@/lib/meetings/transcript";

export type CreateMeetingDataClient = {
  space: {
    findFirst(input: { where: { workspaceId: string }; orderBy: { createdAt: "asc" } }): Promise<{ id: string } | null>;
  };
  note: {
    create(input: {
      data: {
        title: string;
        status: "RECORDING";
        visibility: "PRIVATE";
        date: Date;
        summary: string;
        transcript: string;
        workspaceId: string;
        spaceId: string;
        ownerId: string;
      };
      include: { shares: true };
    }): Promise<unknown>;
  };
};

export type RecordMeetingChunkDataClient = {
  note: {
    findFirst(input: { where: { id: string; workspaceId: string } }): Promise<{ id: string } | null>;
    update(input: { where: { id: string }; data: { transcript: string }; include: { shares: true } }): Promise<unknown>;
  };
  transcriptChunk: {
    upsert(input: {
      where: { noteId_source_index: { noteId: string; source: string; index: number } };
      create: {
        noteId: string;
        source: string;
        index: number;
        startSec: number;
        endSec: number;
        text: string;
        status: "TRANSCRIBED";
      };
      update: {
        startSec: number;
        endSec: number;
        text: string;
        status: "TRANSCRIBED";
        error: null;
      };
    }): Promise<unknown>;
    findMany(input: {
      where: { noteId: string; status: "TRANSCRIBED" };
      orderBy: Array<{ index: "asc" } | { source: "asc" }>;
    }): Promise<Array<{ source: string; index: number; text: string }>>;
  };
};

export type GetMeetingNoteDataClient = {
  note: {
    findFirst(input: { where: { id: string; workspaceId: string }; include: { shares: true } }): Promise<unknown | null>;
  };
};

export type RefreshMeetingInsightsDataClient = {
  note: {
    findFirst(input: { where: { id: string; workspaceId: string } }): Promise<{ id: string; transcript: string } | null>;
    update(input: { where: { id: string }; data: { summary: string }; include: { shares: true } }): Promise<unknown>;
  };
};

export type RecordLiveTranscriptDataClient = {
  note: {
    findFirst(input: { where: { id: string; workspaceId: string } }): Promise<{ id: string } | null>;
    update(input: { where: { id: string }; data: { transcript: string }; include: { shares: true } }): Promise<unknown>;
  };
};

export type FinalizeMeetingDataClient = {
  note: {
    findFirst(input: { where: { id: string; workspaceId: string } }): Promise<{ id: string; transcript: string } | null>;
    update(input: {
      where: { id: string };
      data: { status: "READY"; summary: string };
      include: { shares: true };
    }): Promise<unknown>;
  };
};

export type MeetingProgressProvider = {
  summarizeMeetingProgress(transcript: string): Promise<string>;
};

export type MeetingFinalNotesProvider = {
  finalizeMeetingNotes(input: FinalizeMeetingNotesInput): Promise<string>;
};

export type CreateMeetingNoteInput = {
  title: string;
  userId: string;
  workspaceId: string;
};

export type RecordMeetingChunkInput = {
  noteId: string;
  workspaceId: string;
  source: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
};

export type MeetingNoteInput = {
  noteId: string;
  workspaceId: string;
  supplementalText?: string;
};

export type RecordLiveTranscriptInput = {
  noteId: string;
  workspaceId: string;
  transcript: string;
};

export class EmptyMeetingTranscriptError extends Error {
  constructor() {
    super("Record audio successfully or type a note before generating final notes.");
    this.name = "EmptyMeetingTranscriptError";
  }
}

const initialMeetingSummary = "# Meeting in progress\n- Transcript will update as audio is processed.";

export async function createMeetingNote(input: CreateMeetingNoteInput, db: CreateMeetingDataClient = prisma) {
  const space = await db.space.findFirst({ where: { workspaceId: input.workspaceId }, orderBy: { createdAt: "asc" } });
  if (!space) throw new Error("No space available");

  return db.note.create({
    data: {
      title: input.title,
      status: "RECORDING",
      visibility: "PRIVATE",
      date: new Date(),
      summary: initialMeetingSummary,
      transcript: "",
      workspaceId: input.workspaceId,
      spaceId: space.id,
      ownerId: input.userId,
    },
    include: { shares: true },
  });
}

export async function recordMeetingChunk(input: RecordMeetingChunkInput, db: RecordMeetingChunkDataClient = prisma) {
  const note = await db.note.findFirst({ where: { id: input.noteId, workspaceId: input.workspaceId } });
  if (!note) throw new Error("Meeting note not found");

  await db.transcriptChunk.upsert({
    where: {
      noteId_source_index: {
        noteId: input.noteId,
        source: input.source,
        index: input.index,
      },
    },
    create: {
      noteId: input.noteId,
      source: input.source,
      index: input.index,
      startSec: input.startSec,
      endSec: input.endSec,
      text: input.text.trim(),
      status: "TRANSCRIBED",
    },
    update: {
      startSec: input.startSec,
      endSec: input.endSec,
      text: input.text.trim(),
      status: "TRANSCRIBED",
      error: null,
    },
  });

  const chunks = await db.transcriptChunk.findMany({
    where: { noteId: input.noteId, status: "TRANSCRIBED" },
    orderBy: [{ index: "asc" }, { source: "asc" }],
  });
  const transcript = buildTranscriptFromChunks(chunks);

  return db.note.update({
    where: { id: input.noteId },
    data: { transcript },
    include: { shares: true },
  });
}

export async function getMeetingNote(input: MeetingNoteInput, db: GetMeetingNoteDataClient = prisma) {
  const note = await db.note.findFirst({ where: { id: input.noteId, workspaceId: input.workspaceId }, include: { shares: true } });
  if (!note) throw new Error("Meeting note not found");
  return note;
}

export async function refreshMeetingInsights(
  input: MeetingNoteInput,
  provider: MeetingProgressProvider = getAiProvider(),
  db: RefreshMeetingInsightsDataClient = prisma,
) {
  const note = await db.note.findFirst({ where: { id: input.noteId, workspaceId: input.workspaceId } });
  if (!note) throw new Error("Meeting note not found");

  const summary = await provider.summarizeMeetingProgress(note.transcript);
  return db.note.update({
    where: { id: input.noteId },
    data: { summary },
    include: { shares: true },
  });
}

export async function recordLiveTranscript(input: RecordLiveTranscriptInput, db: RecordLiveTranscriptDataClient = prisma) {
  const note = await db.note.findFirst({ where: { id: input.noteId, workspaceId: input.workspaceId } });
  if (!note) throw new Error("Meeting note not found");
  const text = input.transcript.trim();
  const transcript = hasTranscriptSourceLabel(text) ? text : text ? `Microphone: ${text}` : "";
  return db.note.update({
    where: { id: input.noteId },
    data: { transcript },
    include: { shares: true },
  });
}

function hasTranscriptSourceLabel(text: string) {
  return /^-?\s*(Microphone|System|System audio|Audio):\s/im.test(text);
}

export async function endMeeting(
  input: MeetingNoteInput,
  provider: MeetingFinalNotesProvider = getAiProvider(),
  db: FinalizeMeetingDataClient = prisma,
) {
  const note = await db.note.findFirst({ where: { id: input.noteId, workspaceId: input.workspaceId } });
  if (!note) throw new Error("Meeting note not found");
  const transcript = note.transcript.trim();
  const customInstructions = input.supplementalText?.trim();
  const finalInput: FinalizeMeetingNotesInput = transcript
    ? { transcript, ...(customInstructions ? { customInstructions } : {}) }
    : { transcript: customInstructions || "" };
  if (!finalInput.transcript.trim()) throw new EmptyMeetingTranscriptError();
  const summary = await provider.finalizeMeetingNotes(finalInput);
  return db.note.update({
    where: { id: input.noteId },
    data: { status: "READY", summary },
    include: { shares: true },
  });
}
