export type RealtimeTranscriptItem = {
  itemId: string;
  text: string;
  completed: boolean;
};

export type RealtimeTranscriptState = {
  order: string[];
  items: Record<string, RealtimeTranscriptItem>;
};

type RealtimeTranscriptDeltaEvent = {
  type: "conversation.item.input_audio_transcription.delta";
  item_id?: string;
  delta?: string;
};

type RealtimeTranscriptCompletedEvent = {
  type: "conversation.item.input_audio_transcription.completed";
  item_id?: string;
  transcript?: string;
};

export type RealtimeTranscriptEvent = RealtimeTranscriptDeltaEvent | RealtimeTranscriptCompletedEvent | { type?: string };

export function emptyRealtimeTranscriptState(): RealtimeTranscriptState {
  return { order: [], items: {} };
}

export function realtimeTranscriptStateFromText(text: string): RealtimeTranscriptState {
  const transcript = text.replace(/^Microphone:\s*/i, "").trim();
  if (!transcript) return emptyRealtimeTranscriptState();
  return {
    order: ["initial"],
    items: {
      initial: {
        itemId: "initial",
        text: transcript,
        completed: true,
      },
    },
  };
}

export function applyRealtimeTranscriptEvent(
  state: RealtimeTranscriptState,
  event: RealtimeTranscriptEvent,
): RealtimeTranscriptState {
  if (isRealtimeTranscriptDeltaEvent(event)) {
    const current = state.items[event.item_id] || { itemId: event.item_id, text: "", completed: false };
    const order = state.order.includes(event.item_id) ? state.order : [...state.order, event.item_id];
    return {
      order,
      items: {
        ...state.items,
        [event.item_id]: {
          itemId: event.item_id,
          text: `${current.text}${typeof event.delta === "string" ? event.delta : ""}`,
          completed: false,
        },
      },
    };
  }

  if (!isRealtimeTranscriptCompletedEvent(event)) {
    return state;
  }

  const current = state.items[event.item_id] || { itemId: event.item_id, text: "", completed: false };
  const order = state.order.includes(event.item_id) ? state.order : [...state.order, event.item_id];
  return {
    order,
    items: {
      ...state.items,
      [event.item_id]: {
        itemId: event.item_id,
        text: typeof event.transcript === "string" ? event.transcript : current.text,
        completed: true,
      },
    },
  };
}

export function realtimeTranscriptText(state: RealtimeTranscriptState) {
  return state.order
    .map((itemId) => state.items[itemId]?.text.trim())
    .filter(Boolean)
    .join("\n");
}

function isRealtimeTranscriptDeltaEvent(event: RealtimeTranscriptEvent): event is RealtimeTranscriptDeltaEvent & { item_id: string } {
  return event.type === "conversation.item.input_audio_transcription.delta" && "item_id" in event && typeof event.item_id === "string";
}

function isRealtimeTranscriptCompletedEvent(event: RealtimeTranscriptEvent): event is RealtimeTranscriptCompletedEvent & { item_id: string } {
  return event.type === "conversation.item.input_audio_transcription.completed" && "item_id" in event && typeof event.item_id === "string";
}
