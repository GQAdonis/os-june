import type { Note, TranscriptTurn } from "@prisma/client";

export type AiAnswerInput = {
  question: string;
  note?: Note & { turns: TranscriptTurn[] };
};

export type FinalizeMeetingNotesInput = {
  transcript: string;
  customInstructions?: string;
};

export interface AiProvider {
  summarizeTranscript(transcript: string): Promise<string>;
  summarizeMeetingProgress(transcript: string): Promise<string>;
  finalizeMeetingNotes(input: FinalizeMeetingNotesInput): Promise<string>;
  answerQuestion(input: AiAnswerInput): Promise<string>;
}

export class MockAiProvider implements AiProvider {
  async summarizeTranscript(transcript: string) {
    const source = transcript.trim() || "A short meeting was captured.";
    return [
      "# Meeting Setup",
      `- ${source || "Recording started and participants joined"}`,
      "- Key participants and context were captured",
      "",
      "# Decisions",
      "- Follow up with a concise written recap",
      "- Add any missing details from attendees",
      "",
      "# Next Steps",
      "- Share the note with relevant teammates",
      "- Use chat to ask follow-up questions about the transcript",
    ].join("\n");
  }

  async summarizeMeetingProgress(transcript: string) {
    const source = transcript.trim() || "The meeting has started, but no transcript text has been captured yet.";
    return [
      "# Working Summary",
      `- ${source.split(/[.!?]/)[0] || "Meeting discussion is in progress"}`,
      "",
      "# Decisions",
      "- No confirmed decisions yet",
      "",
      "# Action Items",
      "- Capture follow-up items as the transcript grows",
      "",
      "# Open Questions",
      "- Confirm unclear references before sharing final notes",
    ].join("\n");
  }

  async finalizeMeetingNotes(input: FinalizeMeetingNotesInput) {
    return this.summarizeTranscript(input.transcript);
  }

  async answerQuestion({ question, note }: AiAnswerInput) {
    const corpus = note?.turns.map((turn) => `${turn.speaker}: ${turn.text}`).join(" ") || note?.transcript || "";
    if (/decision|decisions/i.test(question)) {
      return "The clearest decision is to document the meeting and follow up with the relevant participants.";
    }
    if (/todo|next|follow/i.test(question)) {
      return "Recommended follow-ups: share the recap, confirm unclear references, and schedule a deeper discussion if needed.";
    }
    return `Based on the available transcript, ${corpus.slice(0, 180) || "there is not enough meeting context yet."}`;
  }
}

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
  }>;
};

export class OpenAiProvider implements AiProvider {
  constructor(
    private readonly apiKey = process.env.OPENAI_API_KEY,
    private readonly model = process.env.OPENAI_MODEL || "gpt-4o-mini",
  ) {}

  async summarizeTranscript(transcript: string) {
    const output = await this.createResponse({
      instructions: finalMeetingNotesInstructions(),
      input: [
        {
          role: "user",
          content: `Create customer-ready meeting notes from this transcript:\n\n${transcript}`,
        },
      ],
    });

    return output.trim();
  }

  async summarizeMeetingProgress(transcript: string) {
    const output = await this.createResponse({
      instructions:
        "Create concise in-progress meeting notes from the supplied audio transcript. The notes must be written in the same language as the audio/transcript unless the user explicitly asks for another language. Use Markdown headings for Working Summary, Decisions, Action Items, and Open Questions. Preserve uncertainty and do not invent facts.",
      input: [
        {
          role: "user",
          content: `Create working notes from this in-progress transcript:\n\n${transcript}`,
        },
      ],
    });

    return output.trim();
  }

  async finalizeMeetingNotes(input: FinalizeMeetingNotesInput) {
    const output = await this.createResponse({
      instructions: finalMeetingNotesInstructions(),
      input: [
        {
          role: "user",
          content: finalMeetingNotesPrompt(input),
        },
      ],
    });

    return output.trim();
  }

  async answerQuestion({ question, note }: AiAnswerInput) {
    const transcript = note?.turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n") || note?.transcript || "";
    const summary = note?.summary || "";
    const output = await this.createResponse({
      instructions:
        "Answer questions about meeting notes using only the supplied summary and transcript. If the answer is not present, say what is missing and suggest a follow-up.",
      input: [
        {
          role: "user",
          content: [
            `Summary:\n${summary}`,
            `Transcript:\n${transcript}`,
            `Question:\n${question}`,
          ].join("\n\n"),
        },
      ],
    });

    return output.trim();
  }

  private async createResponse(body: {
    instructions: string;
    input: Array<{ role: "user"; content: string }>;
  }) {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required when AI_PROVIDER=openai");
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        instructions: body.instructions,
        input: body.input,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI response failed: ${response.status}`);
    }

    const payload = (await response.json()) as OpenAIResponse;
    const text =
      payload.output_text ||
      payload.output
        ?.flatMap((item) => item.content ?? [])
        .map((content) => content.text)
        .filter(Boolean)
        .join("\n");

    if (!text) {
      throw new Error("OpenAI response did not include output text");
    }

    return text;
  }
}

function finalMeetingNotesInstructions() {
  return "You are an expert meeting-notes assistant. Convert audio transcripts into concise Markdown notes with headings and bullets. The notes must be written in the same language as the audio/transcript unless the user explicitly asks for another language. Use custom instructions/context as guidance for format, audience, focus, language, and output requirements. Do not treat custom instructions as transcript content. Prefer factual language, preserve uncertainty, and do not invent decisions. Do not include transcript links, chat links, URLs, boilerplate footers, app-specific navigation text, template placeholders, or bracketed fields like [Insert Date]. Do not include Date or Participants sections unless the transcript explicitly contains those facts.";
}

function finalMeetingNotesPrompt({ transcript, customInstructions }: FinalizeMeetingNotesInput) {
  const sections = [];
  const instructions = customInstructions?.trim();
  if (instructions) {
    sections.push(`Custom instructions/context:\n${instructions}`);
  }
  sections.push(`Transcript:\n${transcript}`);
  return `Create customer-ready meeting notes from the supplied material.\n\n${sections.join("\n\n")}`;
}

export function getAiProvider(): AiProvider {
  if (process.env.AI_PROVIDER === "openai" || (!process.env.AI_PROVIDER && process.env.OPENAI_API_KEY)) {
    return new OpenAiProvider();
  }
  return new MockAiProvider();
}
