export type LiveTurnBoundaryState = {
  hasBufferedAudio: boolean;
  speechStartedAt: number | null;
  lastSpeechAt: number | null;
  lastCommitAt: number;
};

export type LiveTranscriptSource = "microphone" | "system";

export type LiveTranscriptEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
};

export type LiveTranscriptTurn = {
  source: LiveTranscriptSource;
  fragmentOrder: string[];
  fragments: Record<string, string>;
};

export type LiveTurnBoundaryOptions = {
  silenceThreshold: number;
  silenceMs: number;
  minSpeechMs: number;
  maxTurnMs: number;
};

export function initialLiveTurnBoundaryState(now = 0): LiveTurnBoundaryState {
  return {
    hasBufferedAudio: false,
    speechStartedAt: null,
    lastSpeechAt: null,
    lastCommitAt: now,
  };
}

export function observeLiveTurnAudio(
  state: LiveTurnBoundaryState,
  input: { now: number; level: number },
  options: LiveTurnBoundaryOptions,
) {
  const next: LiveTurnBoundaryState = {
    ...state,
    hasBufferedAudio: true,
  };

  if (input.level >= options.silenceThreshold) {
    return {
      state: {
        ...next,
        speechStartedAt: next.speechStartedAt ?? input.now,
        lastSpeechAt: input.now,
      },
      shouldCommit: false,
    };
  }

  if (next.speechStartedAt === null || next.lastSpeechAt === null) {
    return { state: next, shouldCommit: false };
  }

  const speechDuration = next.lastSpeechAt - next.speechStartedAt;
  const silenceDuration = input.now - next.lastSpeechAt;
  const turnDuration = input.now - next.speechStartedAt;
  const shouldCommit =
    next.hasBufferedAudio &&
    ((speechDuration >= options.minSpeechMs && silenceDuration >= options.silenceMs) || turnDuration >= options.maxTurnMs);

  if (!shouldCommit) return { state: next, shouldCommit: false };
  return {
    state: initialLiveTurnBoundaryState(input.now),
    shouldCommit: true,
  };
}

export function pcm16Base64Level(base64Audio: string) {
  const binary = atob(base64Audio);
  const sampleCount = Math.floor(binary.length / 2);
  if (sampleCount === 0) return 0;

  let sumSquares = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const low = binary.charCodeAt(index * 2);
    const high = binary.charCodeAt(index * 2 + 1);
    const sample = ((high << 8) | low) << 16 >> 16;
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

export function byteTimeDomainLevel(samples: Uint8Array) {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}

const liveTranscriptSourceLabels: Record<LiveTranscriptSource, string> = {
  microphone: "Microphone",
  system: "System",
};

export function applyLiveTranscriptEvent(
  turns: LiveTranscriptTurn[],
  source: LiveTranscriptSource,
  event: LiveTranscriptEvent,
) {
  if (!isLiveTranscriptTurnEvent(event)) return turns;
  if (event.type !== "conversation.item.input_audio_transcription.completed") return turns;

  const key = `${source}:${event.item_id}`;
  const existingIndex = turns.findIndex((turn) => turn.fragmentOrder.includes(key));
  const existing = existingIndex >= 0 ? turns[existingIndex] : null;
  const existingFragment = existing?.fragments[key] || "";
  const text =
    event.type === "conversation.item.input_audio_transcription.completed"
      ? typeof event.transcript === "string" ? event.transcript : existingFragment
      : `${existingFragment}${typeof event.delta === "string" ? event.delta : ""}`;

  if (existingIndex >= 0 && existing) {
    const existingTurnIsLatest = existingIndex === turns.length - 1;
    if (!existingTurnIsLatest) {
      const lateSuffix = transcriptExtensionSuffix(existingFragment, text);
      if (lateSuffix) {
        return [
          ...turns,
          {
            source,
            fragmentOrder: [`${key}:late:${turns.length}`],
            fragments: { [`${key}:late:${turns.length}`]: lateSuffix },
          },
        ];
      }
    }

    return turns.map((turn, index) =>
      index === existingIndex
        ? {
            ...turn,
            fragments: {
              ...turn.fragments,
              [key]: text,
            },
          }
        : turn,
    );
  }

  return [
    ...turns,
    {
      source,
      fragmentOrder: [key],
      fragments: { [key]: text },
    },
  ];
}

export function formatLiveTranscriptTurns(turns: LiveTranscriptTurn[]) {
  return turns
    .map((turn) => ({ ...turn, text: liveTranscriptTurnText(turn) }))
    .filter((turn) => turn.text)
    .map((turn) => `- ${liveTranscriptSourceLabels[turn.source]}: ${turn.text}`)
    .join("\n");
}

function liveTranscriptTurnText(turn: LiveTranscriptTurn) {
  return turn.fragmentOrder
    .map((key) => turn.fragments[key]?.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function transcriptExtensionSuffix(previousText: string, nextText: string) {
  const previous = previousText.trim();
  const next = nextText.trim();
  if (!previous || !next || previous === next) return "";
  if (!next.startsWith(previous)) return "";
  return next.slice(previous.length).replace(/^[\s,.;:!?]+/, "").trim();
}

function isLiveTranscriptTurnEvent(event: LiveTranscriptEvent): event is LiveTranscriptEvent & { item_id: string } {
  return (
    event.type === "conversation.item.input_audio_transcription.completed" &&
    typeof event.item_id === "string"
  );
}
