"use client";

import {
  Bot,
  Check,
  ChevronRight,
  ClipboardList,
  Copy,
  FileText,
  Folder,
  FolderPlus,
  Home,
  Mic,
  Minus,
  PanelLeft,
  Paperclip,
  Search,
  SlidersHorizontal,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NoteDocument } from "@/components/note-document";
import { MeetingView } from "@/features/meetings/components/meeting-view";
import { useEconomyMeeting } from "@/features/meetings/hooks/use-economy-meeting";
import { useLiveMeeting } from "@/features/meetings/hooks/use-live-meeting";
import type { MeetingNote } from "@/features/meetings/types";
import { getQuickNoteCapturePlan } from "@/features/quick-notes/capture-policy";
import { useLiveQuickNote } from "@/features/quick-notes/use-live-quick-note";

type Space = { id: string; name: string; icon: string };
type Share = { id: string; token: string };
type Note = {
  id: string;
  title: string;
  status: string;
  visibility: string;
  date: string;
  summary: string;
  transcript: string;
  shares?: Share[];
};
type CalendarEvent = { id: string; title: string; startsAt: string; endsAt: string; attendees: string };
type CalendarConnection = { id: string; events: CalendarEvent[] } | null;
type Message = { id: string; role: string; content: string };
type FolderItem = { id: string; name: string; description: string; noteIds: string[] };
type TranscriptionSettings = {
  configured: boolean;
  source: "workspace" | "environment" | "none";
  settings: {
    provider: "openai" | "openai-compatible";
    model?: string | null;
    baseUrl?: string | null;
    apiKeyConfigured: boolean;
  } | null;
};
type Bootstrap = {
  user: { id: string; name: string; email: string; avatarUrl?: string | null };
  workspace: { id: string; name: string; slug: string; plan: string };
  spaces: Space[];
  notes: Note[];
  calendar: CalendarConnection;
  recentMessages: Message[];
  transcription: TranscriptionSettings;
};

type View = "home" | "chat" | "note" | "quickNote" | "meeting" | "folder";
type Modal = "audio" | "folder" | "transcriptionSettings" | null;
type QuickNoteStage = "idle" | "recording" | "paused" | "generating";
type QuickNoteMode = "batch" | "live";
type NoteRecipe = { id: string; label: string; prompt: string };
type NoteAssistantPanel = { title: string; status: "thinking" | "ready" | "error"; content: string };

const NOTE_RECIPE_PROMPTS: NoteRecipe[] = [
  {
    id: "follow-up-email",
    label: "Write follow up email",
    prompt:
      "Write a concise follow-up email based only on this note and transcript. Include the key decisions, action items, owners if known, and open questions. Keep it ready to send.",
  },
  {
    id: "todos",
    label: "List my todos",
    prompt:
      "Extract my action items from this note and transcript. Return a concise checklist with owners, deadlines, and missing details when they are available. Do not invent tasks.",
  },
  {
    id: "expand-notes",
    label: "Make notes longer",
    prompt:
      "Expand these notes into a more detailed meeting recap using only the note and transcript. Preserve uncertainty, add useful context, and keep the same language as the source material unless instructed otherwise.",
  },
];

async function postJson<T>(url: string, body: unknown = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

async function patchJson<T>(url: string, body: unknown = {}) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

async function readApiError(response: Response) {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return response.statusText || `Request failed with status ${response.status}`;
}

function formatDate(dateInput: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(dateInput));
}

function formatElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function transcriptSegments(transcript: string) {
  return transcript
    .split(/\n+|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^(System audio|Microphone|Speaker|Jun|Adrian):\s*/i, "").trim())
    .filter(Boolean);
}

async function copyText(value: string) {
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

export function AppShell() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<View>("home");
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [noteQuestion, setNoteQuestion] = useState("");
  const [quickNoteText, setQuickNoteText] = useState("");
  const [quickNotePrompt, setQuickNotePrompt] = useState("");
  const [quickNoteTranscript, setQuickNoteTranscript] = useState("");
  const [quickNoteTranscriptOpen, setQuickNoteTranscriptOpen] = useState(false);
  const [quickNoteStage, setQuickNoteStage] = useState<QuickNoteStage>("idle");
  const [quickNoteElapsed, setQuickNoteElapsed] = useState(0);
  const [quickNoteError, setQuickNoteError] = useState<string | null>(null);
  const [meetingStartError, setMeetingStartError] = useState<string | null>(null);
  const [quickNoteAudioLevel, setQuickNoteAudioLevel] = useState(0);
  const [quickNoteCaptureSource, setQuickNoteCaptureSource] = useState<"browser" | "none">("none");
  const [quickNoteMode, setQuickNoteMode] = useState<QuickNoteMode>("live");
  const [activeQuickNoteMode, setActiveQuickNoteMode] = useState<QuickNoteMode | null>(null);
  const [activeMeetingMode, setActiveMeetingMode] = useState<QuickNoteMode>("live");
  const [noteAssistantPanel, setNoteAssistantPanel] = useState<NoteAssistantPanel | null>(null);
  const [chatThinking, setChatThinking] = useState(false);
  const [chatStarted, setChatStarted] = useState(false);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [transcriptionSettings, setTranscriptionSettings] = useState<TranscriptionSettings | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const economyMeeting = useEconomyMeeting();
  const liveMeeting = useLiveMeeting();
  const liveQuickNote = useLiveQuickNote();
  const [quickNoteLiveNote, setQuickNoteLiveNote] = useState<MeetingNote | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const audioLevelAnimationRef = useRef<number | null>(null);
  const audioLevelContextRef = useRef<AudioContext | null>(null);
  const liveRecorderRef = useRef<MediaRecorder | null>(null);
  const liveTranscriptionTimeoutRef = useRef<number | null>(null);
  const liveTranscriptionActiveRef = useRef(false);
  const liveTranscriptionSessionRef = useRef(0);

  const load = useCallback(async () => {
    let response = await fetch("/api/bootstrap", { cache: "no-store" });
    const isDevelopment = process.env.NODE_ENV !== "production";
    if (response.status === 401 && !isDevelopment) {
      window.location.href = "/login";
      return;
    }
    if (isDevelopment && (response.status === 401 || response.status === 500)) {
      await postJson("/api/auth/demo");
      response = await fetch("/api/bootstrap", { cache: "no-store" });
    }
    if (!response.ok) {
      throw new Error(`Bootstrap failed: ${response.status}`);
    }
    const payload = (await response.json()) as Bootstrap;
    setData(payload);
    setMessages(payload.recentMessages);
    setTranscriptionSettings(payload.transcription);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch(console.error);
  }, [load]);

  useEffect(() => {
    return () => {
      stopQuickNoteTimer();
      stopLiveTranscription();
      liveQuickNote.reset();
      liveMeeting.reset();
      stopAudioLevelMeter();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeNote = useMemo(
    () => data?.notes.find((note) => note.id === activeNoteId) ?? data?.notes[0] ?? null,
    [activeNoteId, data?.notes],
  );
  const activeFolder = useMemo(() => folders.find((folder) => folder.id === activeFolderId) ?? null, [activeFolderId, folders]);

  function createFolder(name: string, description: string) {
    const folder = { id: `folder-${Date.now()}`, name, description, noteIds: [] };
    setFolders((current) => [...current, folder]);
    setActiveFolderId(folder.id);
    setView("folder");
    setModal(null);
  }

  function addNotesToFolder(folderId: string, noteIds: string[]) {
    setFolders((current) =>
      current.map((folder) =>
        folder.id === folderId ? { ...folder, noteIds: Array.from(new Set([...folder.noteIds, ...noteIds])) } : folder,
      ),
    );
  }

  async function createRecording() {
    setBusy(true);
    try {
      const result = await postJson<{ note: Note }>("/api/recordings", {
        title: "Short recording",
        audioText: "Jun introduced the meeting. Adrian joined to discuss the page reference. The team agreed to follow up with complete documentation.",
      });
      setData((current) => (current ? { ...current, notes: [result.note, ...current.notes] } : current));
      setActiveNoteId(result.note.id);
      setView("note");
      setModal(null);
      return result.note;
    } finally {
      setBusy(false);
    }
  }

  function stopQuickNoteTimer() {
    if (elapsedTimerRef.current) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }

  function startQuickNoteTimer(baseSeconds = 0) {
    stopQuickNoteTimer();
    const startedAt = Date.now() - baseSeconds * 1000;
    setQuickNoteElapsed(baseSeconds);
    elapsedTimerRef.current = window.setInterval(() => {
      setQuickNoteElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
  }

  function stopAudioLevelMeter() {
    if (audioLevelAnimationRef.current) {
      window.cancelAnimationFrame(audioLevelAnimationRef.current);
      audioLevelAnimationRef.current = null;
    }
    void audioLevelContextRef.current?.close().catch(() => undefined);
    audioLevelContextRef.current = null;
    setQuickNoteAudioLevel(0);
  }

  function stopLiveTranscription() {
    liveTranscriptionActiveRef.current = false;
    liveTranscriptionSessionRef.current += 1;
    if (liveTranscriptionTimeoutRef.current) {
      window.clearTimeout(liveTranscriptionTimeoutRef.current);
      liveTranscriptionTimeoutRef.current = null;
    }
    const liveRecorder = liveRecorderRef.current;
    liveRecorderRef.current = null;
    if (liveRecorder?.state === "recording") {
      try {
        liveRecorder.requestData();
      } catch {
        // Some recorder implementations do not support manual flushing.
      }
      liveRecorder.stop();
    }
  }

  function stopActiveQuickNoteCapture() {
    stopQuickNoteTimer();
    stopLiveTranscription();
    stopAudioLevelMeter();
    void liveQuickNote.stop().then((note) => {
      if (note) {
        setQuickNoteLiveNote(note);
        upsertMeetingNote(note);
      }
    }).catch(() => undefined);
    void economyMeeting.stopCapture();
    setQuickNoteCaptureSource("none");
    setQuickNoteStage("idle");
    setActiveQuickNoteMode(null);
  }

  async function uploadRecording(audio: Blob, title = "Short recording", audioText?: string, fileName = "meeting-recording.webm") {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("title", title);
      if (audioText?.trim()) form.set("audioText", audioText);
      form.set("audio", audio, fileName);
      const response = await fetch("/api/recordings", { method: "POST", body: form });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as { note: Note };
      setData((current) => (current ? { ...current, notes: [result.note, ...current.notes] } : current));
      setActiveNoteId(result.note.id);
      setView("note");
      setModal(null);
    } finally {
      setBusy(false);
    }
  }

  async function createQuickNoteFromText() {
    const text = quickNoteText.trim();
    if (!text) {
      throw new Error("Record audio successfully or type a note before generating final notes.");
    }
    setBusy(true);
    try {
      const result = await postJson<{ note: Note }>("/api/recordings", {
        title: "New note",
        audioText: text,
      });
      setData((current) => (current ? { ...current, notes: [result.note, ...current.notes] } : current));
      setActiveNoteId(result.note.id);
      setQuickNoteText("");
      setQuickNotePrompt("");
      setQuickNoteTranscript("");
      setQuickNoteTranscriptOpen(false);
      setQuickNoteStage("idle");
      setView("note");
      return result.note;
    } finally {
      setBusy(false);
    }
  }

  async function startQuickNote() {
    if (!transcriptionSettings?.configured) {
      setQuickNoteError("Choose a transcription provider before recording.");
      setModal("transcriptionSettings");
      return;
    }
    const resumedElapsed = quickNoteStage === "paused" ? quickNoteElapsed : 0;
    stopQuickNoteTimer();
    if (quickNoteStage !== "paused") {
      setQuickNoteText("");
      setQuickNotePrompt("");
      setQuickNoteTranscript("");
      setQuickNoteElapsed(0);
    }
    setQuickNoteTranscriptOpen(true);
    setQuickNoteError(null);
    setQuickNoteCaptureSource("none");
    setModal(null);
    setView("quickNote");

    const capturePlan = getQuickNoteCapturePlan();
    const selectedMode = quickNoteStage === "paused" && activeQuickNoteMode ? activeQuickNoteMode : quickNoteMode;

    if (
      !capturePlan.microphone ||
      !navigator.mediaDevices?.getUserMedia ||
      (selectedMode === "live" ? typeof RTCPeerConnection === "undefined" : typeof MediaRecorder === "undefined")
    ) {
      setQuickNoteStage("idle");
      setQuickNoteError((current) => current ?? "Microphone recording is not available in this environment.");
      return;
    }

    try {
      stopQuickNoteTimer();
      stopLiveTranscription();
      stopAudioLevelMeter();
      const note =
        selectedMode === "live"
          ? quickNoteStage === "paused" && quickNoteLiveNote
            ? quickNoteLiveNote
            : await createQuickNoteMeeting()
          : quickNoteStage === "paused" && economyMeeting.note
            ? await economyMeeting.resumeCapture()
            : await economyMeeting.start("New note");
      if (!note) throw new Error("Unable to start quick note recording.");
      upsertMeetingNote(note);
      if (selectedMode === "live") {
        setQuickNoteLiveNote(note);
        await liveQuickNote.start(note.id, note.transcript);
      }
      setActiveQuickNoteMode(selectedMode);
      setQuickNoteStage("recording");
      setQuickNoteCaptureSource("browser");
      startQuickNoteTimer(resumedElapsed);
    } catch (error) {
      setQuickNoteStage("idle");
      setQuickNoteCaptureSource("none");
      stopQuickNoteTimer();
      stopLiveTranscription();
      stopAudioLevelMeter();
      setQuickNoteError(error instanceof Error ? error.message : "Microphone permission is required to start a quick note recording.");
    }
  }

  async function stopQuickNote() {
    if (quickNoteCaptureSource === "none") {
      setQuickNoteStage("paused");
      return;
    }

    setBusy(true);
    stopQuickNoteTimer();
    try {
      if (activeQuickNoteMode === "live") {
        const note = await liveQuickNote.stop();
        if (note) {
          setQuickNoteLiveNote(note);
          upsertMeetingNote(note);
        }
      } else if (activeQuickNoteMode === "batch") {
        await economyMeeting.stopCapture();
      }
      setQuickNoteCaptureSource("none");
      setQuickNoteStage("paused");
    } finally {
      setBusy(false);
    }
  }

  async function generateQuickNote() {
    setQuickNoteStage("generating");
    try {
      if (activeQuickNoteMode === "live" && quickNoteLiveNote) {
        const persisted = liveQuickNote.status === "recording" ? await liveQuickNote.stop() : null;
        const targetNote = persisted || quickNoteLiveNote;
        if (persisted) {
          setQuickNoteLiveNote(persisted);
          upsertMeetingNote(persisted);
        }
        const note = await finalizeQuickNoteMeeting(targetNote.id, quickNoteText);
        if (note) {
          upsertMeetingNote(note);
          setView("note");
        }
      } else if (activeQuickNoteMode === "batch" && economyMeeting.note) {
        const note = await economyMeeting.end(quickNoteText);
        if (note) {
          upsertMeetingNote(note);
          setView("note");
        }
      } else {
        await createQuickNoteFromText();
      }
      setQuickNoteText("");
      setQuickNotePrompt("");
      setQuickNoteTranscript("");
      setQuickNoteTranscriptOpen(false);
      setQuickNoteElapsed(0);
      setQuickNoteStage("idle");
      setQuickNoteLiveNote(null);
      setActiveQuickNoteMode(null);
      liveQuickNote.reset();
    } catch (error) {
      setQuickNoteStage("paused");
      setQuickNoteError(error instanceof Error ? error.message : "Unable to generate notes.");
    }
  }

  async function createQuickNoteMeeting() {
    const result = await postJson<{ note: MeetingNote }>("/api/meetings", { title: "New note" });
    return result.note;
  }

  async function finalizeQuickNoteMeeting(noteId: string, supplementalText?: string) {
    const init: RequestInit = supplementalText?.trim()
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ supplementalText: supplementalText.trim() }),
        }
      : { method: "POST" };
    const response = await fetch(`/api/meetings/${encodeURIComponent(noteId)}/end`, init);
    if (!response.ok) throw new Error(await readApiError(response));
    const payload = (await response.json()) as { note: MeetingNote };
    return payload.note;
  }

  function upsertMeetingNote(note: MeetingNote) {
    const nextNote = note as Note;
    setData((current) => {
      if (!current) return current;
      const exists = current.notes.some((item) => item.id === nextNote.id);
      return {
        ...current,
        notes: exists
          ? current.notes.map((item) => (item.id === nextNote.id ? { ...item, ...nextNote } : item))
          : [nextNote, ...current.notes],
      };
    });
    setActiveNoteId(nextNote.id);
  }

  async function startMeeting() {
    setMeetingStartError(null);
    if (!transcriptionSettings?.configured) {
      setQuickNoteError("Choose a transcription provider before recording.");
      setModal("transcriptionSettings");
      return;
    }
    stopActiveQuickNoteCapture();
    setModal(null);
    setView("meeting");
    const selectedMode = quickNoteMode;
    setActiveMeetingMode(selectedMode);
    try {
      const note = selectedMode === "live" ? await liveMeeting.start("New meeting") : await economyMeeting.start("New meeting");
      upsertMeetingNote(note);
    } catch (error) {
      console.error(error);
      setMeetingStartError(error instanceof Error ? error.message : "Unable to start meeting capture.");
      setView("home");
    }
  }

  async function endActiveMeeting() {
    try {
      const note = activeMeetingMode === "live" ? await liveMeeting.end() : await economyMeeting.end();
      if (note) {
        upsertMeetingNote(note);
        setView("note");
      }
    } catch (error) {
      console.error(error);
    }
  }

  async function startChatWithQuestion(question: string) {
    if (!question.trim()) return;
    const prompt = question.trim();
    setView("chat");
    setActiveFolderId(null);
    setChatInput("");
    setChatStarted(true);
    setChatThinking(true);
    setMessages((current) => [...current, { id: `local-${Date.now()}`, role: "user", content: prompt }]);
    try {
      const result = await postJson<{ message: Message }>("/api/chat", { question: prompt });
      setMessages((current) => [...current, result.message]);
    } finally {
      setChatThinking(false);
    }
  }

  async function askGlobal(event: FormEvent) {
    event.preventDefault();
    await startChatWithQuestion(chatInput);
  }

  async function askNoteQuestion(question: string, title = question) {
    const prompt = question.trim();
    if (!prompt || !activeNote) return;
    setNoteAssistantPanel({ title, status: "thinking", content: "" });
    try {
      const result = await postJson<{ message: Message }>(`/api/notes/${activeNote.id}/chat`, { question: prompt });
      setMessages((current) => [...current, { id: `q-${Date.now()}`, role: "user", content: prompt }, result.message]);
      setNoteAssistantPanel({ title, status: "ready", content: result.message.content });
    } catch (error) {
      setNoteAssistantPanel({
        title,
        status: "error",
        content: error instanceof Error ? error.message : "Unable to run this note prompt.",
      });
    }
  }

  async function askNote(event: FormEvent) {
    event.preventDefault();
    const question = noteQuestion.trim();
    if (!question) return;
    setNoteQuestion("");
    await askNoteQuestion(question);
  }

  async function runNoteRecipe(recipe: NoteRecipe) {
    setNoteQuestion("");
    await askNoteQuestion(recipe.prompt, recipe.label);
  }

  async function updateNoteTitle(noteId: string, title: string) {
    const previousNotes = data?.notes ?? [];
    setData((current) =>
      current
        ? {
            ...current,
            notes: current.notes.map((note) => (note.id === noteId ? { ...note, title } : note)),
          }
        : current,
    );
    try {
      const result = await patchJson<{ note: Note }>(`/api/notes/${noteId}`, { title });
      setData((current) =>
        current
          ? {
              ...current,
              notes: current.notes.map((note) => (note.id === noteId ? result.note : note)),
            }
          : current,
      );
    } catch (error) {
      setData((current) => (current ? { ...current, notes: previousNotes } : current));
      throw error;
    }
  }

  if (!data) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#272727] text-[#a9a69e]">
        Loading workspace...
      </main>
    );
  }

  return (
    <main className="h-screen overflow-hidden bg-[#272727]">
      <div className="flex h-screen w-screen overflow-hidden bg-[#272727]">
        {view !== "quickNote" && (
          <Sidebar
            data={data}
            activeView={view}
            activeFolderId={activeFolderId}
            collapsed={sidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
            folders={folders}
            onCreateFolder={() => setModal("folder")}
            openFolder={(folder) => {
              stopActiveQuickNoteCapture();
              setActiveFolderId(folder.id);
              setView("folder");
            }}
            setView={(nextView) => {
              stopActiveQuickNoteCapture();
              if (nextView !== "folder") setActiveFolderId(null);
              setView(nextView);
            }}
          />
        )}
        <section className="relative flex min-w-0 flex-1 flex-col">
          <TopBar
            view={view}
            onHome={() => {
              stopActiveQuickNoteCapture();
              setView("home");
            }}
            onRecord={startQuickNote}
            onMeeting={startMeeting}
            transcriptionMode={quickNoteMode}
            setTranscriptionMode={setQuickNoteMode}
          />
          {view === "chat" ? (
            <ChatView
              userName={data.user.name}
              notes={data.notes}
              messages={messages}
              active={chatStarted}
              setActive={setChatStarted}
              input={chatInput}
              setInput={setChatInput}
              thinking={chatThinking}
              onSubmit={askGlobal}
              onRecord={startQuickNote}
            />
          ) : view === "quickNote" ? (
            <QuickNoteView
              busy={busy}
              stage={quickNoteStage}
              elapsed={quickNoteElapsed}
              audioLevel={quickNoteAudioLevel}
              error={quickNoteError || liveQuickNote.error || economyMeeting.error}
              noteText={quickNoteText}
              setNoteText={setQuickNoteText}
              transcript={
                activeQuickNoteMode === "live"
                  ? liveQuickNote.transcript || quickNoteLiveNote?.transcript || quickNoteTranscript
                  : economyMeeting.transcript || quickNoteTranscript
              }
              transcriptOpen={quickNoteTranscriptOpen}
              setTranscriptOpen={setQuickNoteTranscriptOpen}
              prompt={quickNotePrompt}
              setPrompt={setQuickNotePrompt}
              onStop={stopQuickNote}
              onResume={startQuickNote}
              onGenerate={generateQuickNote}
            />
          ) : view === "meeting" ? (
            <MeetingView
              title={(activeMeetingMode === "live" ? liveMeeting.note?.title : economyMeeting.note?.title) || "New meeting"}
              elapsedSeconds={activeMeetingMode === "live" ? liveMeeting.elapsedSeconds : economyMeeting.elapsedSeconds}
              audioLevel={activeMeetingMode === "live" ? liveMeeting.audioLevel : economyMeeting.audioLevel}
              transcript={activeMeetingMode === "live" ? liveMeeting.transcript : economyMeeting.transcript}
              summary={activeMeetingMode === "live" ? liveMeeting.summary : economyMeeting.summary}
              status={
                (activeMeetingMode === "live" ? liveMeeting.status : economyMeeting.status) === "ending"
                  ? "ending"
                  : (activeMeetingMode === "live" ? liveMeeting.status : economyMeeting.status) === "ended"
                    ? "ended"
                    : "recording"
              }
              error={activeMeetingMode === "live" ? liveMeeting.error : economyMeeting.error}
              allowEmptyTranscriptEnd={activeMeetingMode === "live"}
              onEnd={endActiveMeeting}
            />
          ) : view === "note" && activeNote ? (
            <NoteView
              note={activeNote}
              question={noteQuestion}
              setQuestion={setNoteQuestion}
              onAsk={askNote}
              assistantPanel={noteAssistantPanel}
              onRunRecipe={runNoteRecipe}
              onCloseAssistantPanel={() => setNoteAssistantPanel(null)}
              folders={folders}
              setFolders={setFolders}
              onAddNoteToFolder={(folderId) => addNotesToFolder(folderId, [activeNote.id])}
              onTitleChange={(title) => updateNoteTitle(activeNote.id, title).catch(console.error)}
            />
          ) : view === "folder" && activeFolder ? (
            <FolderView
              folder={activeFolder}
              notes={data.notes}
              onRecord={startQuickNote}
              onStartChat={startChatWithQuestion}
              onAddNotes={(noteIds) => addNotesToFolder(activeFolder.id, noteIds)}
              openNote={(note) => {
                setActiveNoteId(note.id);
                setView("note");
              }}
            />
          ) : (
            <HomeView
              notes={data.notes}
              meetingStartError={meetingStartError}
              onOpenAudioPermissions={() => window.openNotepadDesktop?.recorder?.openPermissions?.()}
              openNote={(note) => {
                setActiveNoteId(note.id);
                setView("note");
              }}
            />
          )}
          {modal === "audio" && <AudioPermissionModal busy={busy} onCreateDemo={createRecording} onCreateAudio={uploadRecording} />}
          {modal === "folder" && <CreateFolderModal onClose={() => setModal(null)} onCreate={createFolder} />}
          {modal === "transcriptionSettings" && (
            <TranscriptionSettingsModal
              initial={transcriptionSettings}
              onClose={() => setModal(null)}
              onSaved={(settings) => {
                setTranscriptionSettings(settings);
                setData((current) => (current ? { ...current, transcription: settings } : current));
                setModal(null);
              }}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function Sidebar({
  data,
  setView,
  activeView,
  activeFolderId,
  collapsed,
  setCollapsed,
  folders,
  onCreateFolder,
  openFolder,
}: {
  data: Bootstrap;
  setView: (view: View) => void;
  activeView: View;
  activeFolderId: string | null;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  folders: FolderItem[];
  onCreateFolder: () => void;
  openFolder: (folder: FolderItem) => void;
}) {
  return (
    <aside className={`hidden shrink-0 flex-col border-r border-[#3c3b38] bg-[#202020] pb-5 pt-[52px] transition-[width] duration-200 md:flex ${collapsed ? "w-[76px] px-3" : "w-[248px] px-4"}`}>
      <div className={`mb-6 flex ${collapsed ? "justify-center" : "justify-end"}`}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="rounded-lg p-2 text-[#8e8b85] transition hover:bg-[#343331] hover:text-[#f0eee8]"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <PanelLeft className="h-5 w-5" />
        </button>
      </div>
      <nav className="mt-3 space-y-1 text-[1rem] font-medium text-[#aaa79f]">
        <button
          onClick={() => setView("home")}
          className={`nav-item ${collapsed ? "justify-center px-0" : ""} ${activeView === "home" ? "bg-[#343331] text-[#e8e5dd]" : ""}`}
          title="Home"
        >
          <Home className="h-5 w-5 shrink-0" /> {!collapsed && "Home"}
        </button>
        <button
          onClick={() => setView("chat")}
          className={`nav-item ${collapsed ? "justify-center px-0" : ""} ${activeView === "chat" ? "bg-[#343331] text-[#e8e5dd]" : ""}`}
          title="Chat"
        >
          <Bot className="h-5 w-5 shrink-0" /> {!collapsed && "Chat"}
        </button>
      </nav>
      {!collapsed && (
        <div className="mt-7">
          <div className="mb-3 text-sm font-semibold text-[#9e9b93]">Folders</div>
          <div className="space-y-2 text-[1rem] font-medium">
            <div className="flex items-center gap-3 text-[#e1ded6]">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#3a3936]">
                <FileText className="h-5 w-5" />
              </span>
              My notes
            </div>
            {folders.map((folder) => (
              <button
                key={folder.id}
                onClick={() => openFolder(folder)}
                className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-[#343331] hover:text-[#f0eee8] ${
                  activeView === "folder" && activeFolderId === folder.id ? "bg-[#343331] text-[#e8e5dd]" : "text-[#aaa79f]"
                }`}
              >
                <Folder className="h-5 w-5 shrink-0" />
                <span className="truncate">{folder.name}</span>
              </button>
            ))}
            <button onClick={onCreateFolder} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-[#85827b] transition hover:bg-[#343331] hover:text-[#f0eee8]">
              <FolderPlus className="h-5 w-5" /> Add folder
            </button>
          </div>
        </div>
      )}
      <div className="mt-auto space-y-4">
        <div className={`flex items-center gap-3 border-t border-[#383733] pt-4 font-semibold text-[#ece9e2] ${collapsed ? "justify-center" : ""}`}>
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#f0eee8] text-[#202020]">∿</span>
          {!collapsed && <span className="truncate">{data.user.name}</span>}
        </div>
      </div>
    </aside>
  );
}

function TopBar({
  view,
  onHome,
  onRecord,
  onMeeting,
  transcriptionMode,
  setTranscriptionMode,
}: {
  view: View;
  onHome: () => void;
  onRecord: () => void;
  onMeeting: () => void;
  transcriptionMode: QuickNoteMode;
  setTranscriptionMode: (mode: QuickNoteMode) => void;
}) {
  return (
    <header className={`desktop-titlebar flex h-16 shrink-0 items-center justify-between pr-4 sm:pr-7 ${view === "quickNote" ? "pl-28" : "pl-4 sm:pl-7"}`}>
      <div className="flex items-center gap-2">
        {view !== "home" && (
          <button
            onClick={onHome}
            className="flex h-11 items-center gap-2 rounded-full border border-[#43413d] px-3 text-[#a19e97] transition hover:bg-[#353432] hover:text-[#f0eee8]"
            aria-label="Go home"
            title="Home"
          >
            <span className="text-xl leading-none">‹</span>
            <Home className="h-5 w-5" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {view === "home" ? (
          <>
            <div className="mr-2 flex h-10 items-center rounded-full border border-[#4a4945] bg-[#302f2d] p-1" aria-label="Transcription mode">
              {(["batch", "live"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setTranscriptionMode(mode)}
                  className={`h-8 rounded-full px-3 text-sm font-semibold transition ${
                    transcriptionMode === mode
                      ? "bg-[#c8c6bf] text-[#2b2b2a]"
                      : "text-[#aaa69e] hover:bg-[#3c3b38] hover:text-[#f0eee8]"
                  }`}
                  aria-pressed={transcriptionMode === mode}
                >
                  {mode === "batch" ? "Batch mode" : "Live mode"}
                </button>
              ))}
            </div>
            <button onClick={onMeeting} className="rounded-full bg-[#c8c6bf] px-4 py-2 font-semibold text-[#2b2b2a] transition hover:bg-[#e2ded4]">
              <Mic className="mr-2 inline h-4 w-4" />
              Start Meeting
            </button>
            <button onClick={onRecord} className="rounded-full border border-[#4a4945] px-4 py-2 font-semibold text-[#e8e5dd]">
              + Quick note
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}

function QuickNoteView({
  busy,
  stage,
  elapsed,
  audioLevel,
  error,
  noteText,
  setNoteText,
  transcript,
  transcriptOpen,
  setTranscriptOpen,
  prompt,
  setPrompt,
  onStop,
  onResume,
  onGenerate,
}: {
  busy: boolean;
  stage: QuickNoteStage;
  elapsed: number;
  audioLevel: number;
  error: string | null;
  noteText: string;
  setNoteText: (value: string) => void;
  transcript: string;
  transcriptOpen: boolean;
  setTranscriptOpen: (open: boolean) => void;
  prompt: string;
  setPrompt: (value: string) => void;
  onStop: () => void;
  onResume: () => void;
  onGenerate: () => void;
}) {
  const recording = stage === "recording";
  const paused = stage === "paused";
  const generating = stage === "generating";
  const elapsedLabel = formatElapsed(elapsed);

  return (
    <div className="relative flex flex-1 flex-col px-8 pb-8 pt-8">
      <div className="mx-auto w-full max-w-[880px]">
        <h1 className="font-editorial text-4xl text-[#817e77]">New note</h1>
        <div className="mt-7 flex flex-wrap gap-2">
          <button className="rounded-full border border-[#494844] px-4 py-2 font-semibold text-[#a7a39c]">
            <span className="mr-2">▣</span>Today
          </button>
          <button className="rounded-full border border-[#494844] px-4 py-2 font-semibold text-[#a7a39c]">
            <UsersRound className="mr-2 inline h-5 w-5" />
            Me
          </button>
          <button className="rounded-full border border-[#494844] px-4 py-2 font-semibold text-[#a7a39c]">
            <FolderPlus className="mr-2 inline h-5 w-5" />
            Add to folder
          </button>
        </div>
        <textarea
          value={noteText}
          onChange={(event) => setNoteText(event.target.value)}
          placeholder="Add context, instructions, or notes"
          className="mt-8 min-h-[46vh] w-full resize-none bg-transparent text-2xl leading-9 text-[#c9c6bd] outline-none placeholder:text-[#77736c]"
        />
        {error && (
          <div className="mt-4 rounded-2xl border border-[#6b5a2c] bg-[#352d1f] px-4 py-3 text-[#d8c690]">
            <span>{error}</span>
          </div>
        )}
      </div>
      {transcriptOpen && (
        <TranscriptDrawer
          transcript={transcript}
          elapsed={elapsed}
          audioLevel={audioLevel}
          recording={recording}
          onToggleTranscript={() => setTranscriptOpen(false)}
          onResume={paused ? onResume : undefined}
          onClose={() => setTranscriptOpen(false)}
        />
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-7 flex flex-col items-center gap-5 px-8">
        {paused && (
          <button
            onClick={onGenerate}
            disabled={busy}
            className="pointer-events-auto rounded-full bg-[#7d8d25] px-6 py-3 text-base font-semibold text-[#f4f2e8] shadow-xl disabled:opacity-60"
          >
            <Sparkles className="mr-2 inline h-5 w-5" />
            Generate notes
          </button>
        )}
        {generating && (
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-[#4b4a46] bg-[#373735] px-6 py-3 text-[#d6d2ca] shadow-xl">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#85827b] border-t-[#a8bf3b]" />
            Generating notes...
          </div>
        )}
        {recording && (
          <div className="pointer-events-auto flex items-center gap-2 text-lg font-medium text-[#aaa69e]">
            <span>Always get consent when transcribing others</span>
            <ChevronRight className="h-5 w-5" />
          </div>
        )}
        <div className="pointer-events-auto flex w-full max-w-[980px] items-center gap-3">
          <div className="flex h-[74px] shrink-0 items-center gap-5 rounded-full border border-[#4b4a46] bg-[#373735] px-6 shadow-xl">
            <button
              type="button"
              onClick={() => setTranscriptOpen(!transcriptOpen)}
              className="flex items-center gap-3 rounded-full text-[#aaa69e] transition hover:text-[#f0eee8]"
              aria-label={transcriptOpen ? "Hide transcript" : "Show transcript"}
            >
              <WaveformIcon live={recording} level={recording ? audioLevel : 0} />
              {recording && <span className="w-12 font-mono text-sm">{elapsedLabel}</span>}
              <span className="text-xl leading-none">{transcriptOpen ? "⌄" : "⌃"}</span>
            </button>
            {recording ? (
              <button
                onClick={onStop}
                disabled={busy}
                className="grid h-7 w-7 place-items-center rounded-md bg-[#c8c6bf] text-[#2b2b2a] disabled:opacity-60"
                aria-label="Stop recording"
              >
                ■
              </button>
            ) : (
              <button
                onClick={onResume}
                disabled={busy || generating}
                className="rounded-full px-1 text-lg font-semibold text-[#a8bf3b] transition hover:text-[#c6dc57] disabled:opacity-60"
              >
                Resume
              </button>
            )}
          </div>
          <form
            className="flex h-[74px] min-w-0 flex-1 items-center rounded-full border border-[#4b4a46] bg-[#373735] px-7 shadow-xl"
            onSubmit={(event) => {
              event.preventDefault();
              if (prompt.trim()) setNoteText(noteText ? `${noteText}\n${prompt}` : prompt);
              setPrompt("");
            }}
          >
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-xl text-[#ddd9d0] outline-none placeholder:text-[#aaa69e]"
              placeholder="Add context or format instruction"
            />
            <button
              type="button"
              onClick={() => setPrompt("Write follow up email")}
              className="shrink-0 rounded-full border border-[#55534f] px-5 py-3 font-semibold text-[#dedbd3] transition hover:bg-[#464541] hover:text-[#f4f2eb]"
            >
              <ClipboardList className="mr-2 inline h-5 w-5" />
              Write follow up email
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function HomeView({
  notes,
  meetingStartError,
  onOpenAudioPermissions,
  openNote,
}: {
  notes: Note[];
  meetingStartError: string | null;
  onOpenAudioPermissions: () => void;
  openNote: (note: Note) => void;
}) {
  return (
    <div className="scrollbar-soft flex-1 overflow-y-auto px-6 pb-24 pt-6">
      <div className="mx-auto max-w-[720px]">
        <h1 className="font-editorial text-3xl text-[#f0eee8]">Notes</h1>
        {meetingStartError && (
          <div className="mt-6 rounded-xl border border-[#6b4f3c] bg-[#3a2d25] p-4 text-[#f0d7c0]">
            <div className="font-semibold">Meeting capture needs attention</div>
            <div className="mt-1 text-sm leading-6">{meetingStartError}</div>
            <button
              type="button"
              onClick={onOpenAudioPermissions}
              className="mt-3 rounded-full border border-[#8b6a52] px-4 py-2 text-sm font-semibold text-[#f4e0ca] transition hover:bg-[#493629]"
            >
              Open audio permissions
            </button>
          </div>
        )}
        <section className="mt-10 space-y-5 text-[#88847c]">
          {notes.length === 0 && (
            <div className="rounded-2xl border border-[#4a4945] bg-[#343331] p-6 text-[#aaa69e]">
              Start a quick note to create your first note.
            </div>
          )}
          {notes.map((note) => (
            <button
              key={note.id}
              onClick={() => openNote(note)}
              className="grid w-full grid-cols-[48px_1fr_90px] items-center gap-4 rounded-2xl p-2 text-left transition hover:bg-[#343331]"
            >
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-[#42413e]">
                <FileText className="h-5 w-5" />
              </span>
              <span>
                <span className="block text-xl font-semibold text-[#aaa69e]">{note.title}</span>
                <span>{formatDate(note.date)} · Me</span>
              </span>
              <span className="text-right text-sm">{new Date(note.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}

function CreateFolderModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, description: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const canCreate = name.trim().length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    onCreate(name.trim(), description.trim());
  }

  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-[#202020]/55 backdrop-blur-[6px]">
      <form
        onSubmit={submit}
        className="w-[min(660px,calc(100%-2rem))] overflow-hidden rounded-[22px] border border-[#484744] bg-[#242424] text-[#f0eee8] shadow-2xl"
      >
        <div className="flex h-16 items-center justify-between border-b border-[#383733] px-7">
          <div className="flex items-center gap-3 text-lg font-semibold">
            <Folder className="h-5 w-5 text-[#d7d3ca]" />
            Create private folder
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-[#aaa69e] transition hover:bg-[#363634] hover:text-[#f0eee8]" aria-label="Close">
            ×
          </button>
        </div>
        <div className="space-y-8 px-7 py-7">
          <label className="block">
            <span className="mb-3 block text-base font-semibold text-[#e2ded5]">Title and icon</span>
            <span className="flex h-14 items-center gap-4 rounded-xl border-2 border-[#6f8422] bg-[#30302e] px-3">
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-[#55534e] text-[#d7d3ca]">
                <Folder className="h-6 w-6" />
              </span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none placeholder:text-[#77736c]"
                placeholder="Folder name"
              />
            </span>
          </label>
          <label className="block">
            <span className="mb-3 block text-base font-semibold text-[#e2ded5]">Description</span>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-28 w-full resize-none rounded-xl border border-[#494844] bg-[#202020] px-4 py-3 text-lg outline-none placeholder:text-[#77736c] focus:border-[#6f8422]"
              placeholder="Describe the purpose of this folder"
            />
          </label>
        </div>
        <div className="flex items-center justify-between border-t border-[#383733] px-6 py-5">
          <button type="button" onClick={onClose} className="rounded-xl border border-[#464541] px-5 py-3 text-lg font-semibold transition hover:bg-[#353432]">
            Cancel
          </button>
          <button
            disabled={!canCreate}
            className="rounded-xl bg-[#f0eee8] px-7 py-3 text-lg font-semibold text-[#2b2b2a] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

function TranscriptionSettingsModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: TranscriptionSettings | null;
  onClose: () => void;
  onSaved: (settings: TranscriptionSettings) => void;
}) {
  const [provider, setProvider] = useState<"openai" | "openai-compatible">(initial?.settings?.provider || "openai");
  const [model, setModel] = useState(initial?.settings?.model || "gpt-4o-mini-transcribe");
  const [baseUrl, setBaseUrl] = useState(initial?.settings?.baseUrl || "http://localhost:8000/v1");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/transcription-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          model,
          baseUrl: provider === "openai-compatible" ? baseUrl : undefined,
          apiKey: apiKey || undefined,
        }),
      });
      const payload = (await response.json()) as TranscriptionSettings | { error?: string };
      if (!response.ok) throw new Error("error" in payload ? payload.error : "Unable to save transcription settings");
      onSaved(payload as TranscriptionSettings);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save transcription settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-[#202020]/55 backdrop-blur-[6px]">
      <form
        onSubmit={save}
        className="w-[min(680px,calc(100%-2rem))] overflow-hidden rounded-[22px] border border-[#484744] bg-[#242424] text-[#f0eee8] shadow-2xl"
      >
        <div className="flex h-16 items-center justify-between border-b border-[#383733] px-7">
          <div>
            <div className="text-lg font-semibold">Transcription setup required</div>
            <div className="text-sm text-[#aaa69e]">Choose where audio transcription runs.</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-[#aaa69e] transition hover:bg-[#363634] hover:text-[#f0eee8]" aria-label="Close">
            ×
          </button>
        </div>
        <div className="space-y-6 px-7 py-7">
          <div className="grid grid-cols-2 gap-3">
            {[
              ["openai", "OpenAI"],
              ["openai-compatible", "OpenAI-compatible"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setProvider(value as "openai" | "openai-compatible");
                  if (value === "openai" && model === "whisper-1") setModel("gpt-4o-mini-transcribe");
                }}
                className={`rounded-xl border px-4 py-3 text-left font-semibold transition hover:bg-[#343331] ${
                  provider === value ? "border-[#7d8d25] bg-[#343331] text-[#f0eee8]" : "border-[#494844] text-[#aaa69e]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {provider === "openai-compatible" && (
            <label className="block">
              <span className="mb-2 block font-semibold text-[#d7d3ca]">Base URL</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                className="h-12 w-full rounded-xl border border-[#494844] bg-[#202020] px-4 outline-none focus:border-[#7d8d25]"
                placeholder="http://localhost:8000/v1"
              />
            </label>
          )}
          <label className="block">
            <span className="mb-2 block font-semibold text-[#d7d3ca]">Model</span>
            {provider === "openai" ? (
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="h-12 w-full rounded-xl border border-[#494844] bg-[#202020] px-4 outline-none focus:border-[#7d8d25]"
              >
                {["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-4o-transcribe-diarize", "whisper-1"].map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="h-12 w-full rounded-xl border border-[#494844] bg-[#202020] px-4 outline-none focus:border-[#7d8d25]"
                placeholder="whisper-1"
              />
            )}
          </label>
          <label className="block">
            <span className="mb-2 block font-semibold text-[#d7d3ca]">API key {provider === "openai-compatible" ? "(optional)" : ""}</span>
            <input
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              type="password"
              className="h-12 w-full rounded-xl border border-[#494844] bg-[#202020] px-4 outline-none focus:border-[#7d8d25]"
              placeholder={initial?.settings?.apiKeyConfigured ? "Saved API key will be kept" : "sk-..."}
            />
          </label>
          {initial?.source === "environment" && (
            <div className="rounded-xl border border-[#494844] bg-[#2f2f2d] px-4 py-3 text-sm text-[#aaa69e]">
              Environment defaults are configured. Saving here overrides them for this workspace.
            </div>
          )}
          {error && <div className="rounded-xl border border-[#6b3d3d] bg-[#372525] px-4 py-3 text-[#f1b4a8]">{error}</div>}
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-[#383733] px-6 py-5">
          <button type="button" onClick={onClose} className="rounded-xl border border-[#464541] px-5 py-3 font-semibold transition hover:bg-[#353432]">
            Cancel
          </button>
          <button disabled={saving} className="rounded-xl bg-[#f0eee8] px-7 py-3 font-semibold text-[#2b2b2a] transition hover:bg-white disabled:opacity-50">
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

function FolderView({
  folder,
  notes,
  onRecord,
  onStartChat,
  onAddNotes,
  openNote,
}: {
  folder: FolderItem;
  notes: Note[];
  onRecord: () => void;
  onStartChat: (prompt: string) => void;
  onAddNotes: (noteIds: string[]) => void;
  openNote: (note: Note) => void;
}) {
  const [description, setDescription] = useState(folder.description);
  const [prompt, setPrompt] = useState("");
  const [tab, setTab] = useState<"notes" | "files">("notes");
  const [addNotesOpen, setAddNotesOpen] = useState(false);
  const folderNotes = notes.filter((note) => folder.noteIds.includes(note.id));
  const hasNotes = folderNotes.length > 0;

  return (
    <div className="scrollbar-soft flex-1 overflow-y-auto px-6 pb-24">
      <div className="mx-auto max-w-[900px] pt-8">
        <div className="flex items-center gap-4">
          <span className="grid h-11 w-11 place-items-center rounded-lg bg-[#55534e] text-[#d7d3ca]">
            <Folder className="h-7 w-7" />
          </span>
          <h1 className="font-editorial text-4xl text-[#f0eee8]">{folder.name}</h1>
        </div>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Add description"
          className="mt-7 w-full bg-transparent text-xl font-semibold text-[#aaa69e] outline-none placeholder:text-[#77736c]"
        />
        <div className="mt-16">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!hasNotes) return;
              onStartChat(prompt);
              setPrompt("");
            }}
            className={`flex h-20 items-center gap-4 rounded-full border border-[#45443f] bg-[#343331] px-7 ${hasNotes ? "" : "opacity-55"}`}
          >
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={!hasNotes}
              className="min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-[#77736c]"
              placeholder={hasNotes ? "Ask this folder anything" : "Add notes to start asking questions"}
            />
            <button
              type="button"
              onClick={onRecord}
              className="grid h-12 w-12 place-items-center rounded-full bg-[#42413e] text-[#aaa69e] transition hover:bg-[#55534e] hover:text-[#f0eee8] disabled:cursor-not-allowed"
              aria-label="Record audio for chat"
            >
              <Mic className="h-5 w-5" />
            </button>
          </form>
          <div className="mt-7 flex flex-wrap items-center gap-5 text-lg font-semibold text-[#aaa69e]">
            {["List recent todos", "Summarize this folder", "Show action items"].map((recipe) => (
              <button
                key={recipe}
                disabled={!hasNotes}
                onClick={() => onStartChat(recipe)}
                className="transition hover:text-[#f0eee8] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <ClipboardList className="mr-2 inline h-4 w-4" />
                {recipe}
              </button>
            ))}
            <button
              disabled={!hasNotes}
              onClick={() => onStartChat("Show all useful recipes for this folder")}
              className="ml-auto transition hover:text-[#f0eee8] disabled:cursor-not-allowed disabled:opacity-45"
            >
              All recipes
            </button>
          </div>
        </div>
        <div className="mt-20 flex gap-3">
          <button
            onClick={() => setTab("notes")}
            className={`rounded-full border px-5 py-2 font-semibold transition hover:bg-[#343331] hover:text-[#f0eee8] ${
              tab === "notes" ? "border-[#56544f] bg-[#3a3936] text-[#f0eee8]" : "border-[#45443f] text-[#aaa69e]"
            }`}
          >
            Notes
          </button>
          <button
            onClick={() => setTab("files")}
            className={`rounded-full border px-5 py-2 font-semibold transition hover:bg-[#343331] hover:text-[#f0eee8] ${
              tab === "files" ? "border-[#6f8422] bg-[#3a3936] text-[#f0eee8]" : "border-[#45443f] text-[#aaa69e]"
            }`}
          >
            Files
          </button>
        </div>
        {tab === "notes" ? (
          hasNotes ? (
            <div className="mt-8 space-y-3">
              {folderNotes.map((note) => (
                <button
                  key={note.id}
                  onClick={() => openNote(note)}
                  className="grid w-full grid-cols-[44px_1fr_92px] items-center gap-4 rounded-2xl px-3 py-3 text-left transition hover:bg-[#343331]"
                >
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-[#42413e] text-[#aaa69e]">
                    <FileText className="h-5 w-5" />
                  </span>
                  <span>
                    <span className="block text-lg font-semibold text-[#f0eee8]">{note.title}</span>
                    <span className="text-[#88847c]">Me</span>
                  </span>
                  <span className="text-right text-sm text-[#88847c]">
                    {new Date(note.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-32 grid place-items-center text-center">
              <div className="mb-7 grid h-20 w-20 place-items-center rounded-2xl border border-[#3f3e3a] text-[#5e5b54]">
                <FileText className="h-10 w-10" />
              </div>
              <div className="text-xl font-semibold text-[#c9c6bd]">No notes here yet</div>
              <div className="mt-2 text-lg text-[#77736c]">Drag and drop notes here to add them</div>
              <button
                onClick={() => setAddNotesOpen(true)}
                className="mt-7 rounded-full bg-[#f0eee8] px-6 py-3 font-semibold text-[#2b2b2a] transition hover:bg-white"
              >
                Add notes
              </button>
            </div>
          )
        ) : (
          <div className="mt-4 grid min-h-[420px] place-items-center rounded-2xl border-2 border-dashed border-[#55534e] text-center">
            <div>
              <div className="mx-auto mb-8 grid h-24 w-24 place-items-center rounded-2xl border border-[#4b4a46] text-[#55534e]">
                <FileText className="h-12 w-12" />
              </div>
              <div className="text-xl font-semibold text-[#c9c6bd]">Adding files gives more context to Ask OS Notepad</div>
              <div className="mt-2 text-lg text-[#88847c]">Drag and drop files here to add them, or paste text</div>
            </div>
          </div>
        )}
      </div>
      {addNotesOpen && (
        <AddNotesToFolderModal
          folder={folder}
          notes={notes}
          onClose={() => setAddNotesOpen(false)}
          onAdd={(noteIds) => {
            onAddNotes(noteIds);
            setAddNotesOpen(false);
          }}
        />
      )}
    </div>
  );
}

function AddNotesToFolderModal({
  folder,
  notes,
  onClose,
  onAdd,
}: {
  folder: FolderItem;
  notes: Note[];
  onClose: () => void;
  onAdd: (noteIds: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const availableNotes = notes.filter((note) => !folder.noteIds.includes(note.id));
  const filteredNotes = availableNotes.filter((note) => note.title.toLowerCase().includes(query.trim().toLowerCase()));

  function toggle(noteId: string) {
    setSelected((current) => (current.includes(noteId) ? current.filter((id) => id !== noteId) : [...current, noteId]));
  }

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-[#111]/55 backdrop-blur-[4px]">
      <div className="flex h-[min(700px,calc(100%-4rem))] w-[min(680px,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border border-[#4b4a46] bg-[#282828] shadow-2xl">
        <div className="flex h-16 items-center gap-4 border-b border-[#3d3c39] px-6 text-[#aaa69e]">
          <Search className="h-5 w-5" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-xl text-[#f0eee8] outline-none placeholder:text-[#88847c]"
            placeholder="Search meetings to add..."
          />
          <button onClick={onClose} className="rounded-full p-2 text-2xl leading-none transition hover:bg-[#3a3936] hover:text-[#f0eee8]" aria-label="Close">
            ×
          </button>
        </div>
        <div className="scrollbar-soft flex-1 overflow-y-auto px-6 py-6">
          <div className="mb-5 font-semibold text-[#aaa69e]">Today</div>
          <div className="space-y-3">
            {filteredNotes.map((note) => (
              <button
                key={note.id}
                onClick={() => toggle(note.id)}
                className="grid w-full grid-cols-[44px_1fr_32px] items-center gap-4 rounded-xl py-2 text-left transition hover:bg-[#353432]"
              >
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-[#55534e] text-[#c9c6bd]">
                  <FileText className="h-5 w-5" />
                </span>
                <span>
                  <span className="block text-lg font-semibold text-[#f0eee8]">{note.title}</span>
                  <span className="text-[#aaa69e]">Me</span>
                </span>
                <span
                  className={`grid h-6 w-6 place-items-center rounded-md border ${
                    selected.includes(note.id) ? "border-[#a8bf3b] bg-[#a8bf3b] text-[#202020]" : "border-[#5a5853]"
                  }`}
                >
                  {selected.includes(note.id) ? <Check className="h-4 w-4" /> : null}
                </span>
              </button>
            ))}
            {filteredNotes.length === 0 && <div className="py-16 text-center text-[#88847c]">No notes available to add.</div>}
          </div>
        </div>
        <div className="flex h-20 items-center justify-end border-t border-[#3d3c39] px-6">
          <button
            disabled={selected.length === 0}
            onClick={() => onAdd(selected)}
            className="rounded-xl bg-[#f0eee8] px-6 py-3 font-semibold text-[#2b2b2a] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-35"
          >
            Add {selected.length} notes
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatView({
  userName,
  notes,
  messages,
  active,
  setActive,
  input,
  setInput,
  thinking,
  onSubmit,
  onRecord,
}: {
  userName: string;
  notes: Note[];
  messages: Message[];
  active: boolean;
  setActive: (active: boolean) => void;
  input: string;
  setInput: (value: string) => void;
  thinking: boolean;
  onSubmit: (event: FormEvent) => void;
  onRecord: () => void;
}) {
  const hasConversation = active || thinking;
  const recents = notes.slice(0, 2);
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <div className="relative flex flex-1 flex-col px-6">
      {hasConversation && (
        <div className="desktop-titlebar absolute left-6 right-6 top-0 z-10 flex h-14 items-center justify-between text-[#c8c4bc]">
          <div className="relative">
            <button
              onClick={() => setHistoryOpen((open) => !open)}
              className="rounded-full border border-[#464541] px-4 py-2 font-semibold transition hover:bg-[#353432] hover:text-[#f0eee8]"
            >
              History⌄
            </button>
            {historyOpen && (
              <div className="absolute left-0 top-12 w-[520px] rounded-[22px] border border-[#56544f] bg-[#363634] p-3 shadow-2xl">
                <div className="px-3 py-2 text-sm font-semibold text-[#aaa69e]">Today</div>
                {recents.map((note, index) => (
                  <button
                    key={note.id}
                    onClick={() => {
                      setActive(true);
                      setHistoryOpen(false);
                    }}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-lg font-semibold transition hover:bg-[#464541]"
                  >
                    {index === 0 ? <Bot className="h-5 w-5 text-[#aaa69e]" /> : <FileText className="h-5 w-5 text-[#aaa69e]" />}
                    <span className="truncate">{note.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => {
              setInput("");
              setActive(false);
              setHistoryOpen(false);
            }}
            className="rounded-full border border-[#464541] px-4 py-2 font-semibold transition hover:bg-[#353432] hover:text-[#f0eee8]"
          >
            New chat
          </button>
        </div>
      )}
      {!hasConversation ? (
        <div className="mx-auto flex w-full max-w-[820px] flex-1 flex-col justify-center">
          <h1 className="font-editorial text-3xl text-[#f0eee8]">Hi {userName}, ask anything</h1>
          <ChatComposer input={input} setInput={setInput} onSubmit={onSubmit} onRecord={onRecord} autoFocus />
          {recents.length > 0 && (
            <div className="mt-10">
              <div className="mb-5 font-semibold text-[#aaa69e]">Recents</div>
              <div className="space-y-3">
                {recents.map((note, index) => (
                  <button
                    key={note.id}
                    onClick={() => setActive(true)}
                    className="grid w-full grid-cols-[48px_1fr_64px] items-center gap-4 rounded-2xl px-2 py-1 text-left transition hover:bg-[#343331]"
                  >
                    <span className="grid h-10 w-10 place-items-center rounded-lg bg-[#42413e] text-[#d7d3ca]">
                      {index === 0 ? <Bot className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                    </span>
                    <span className="truncate text-lg font-semibold text-[#f0eee8]">{note.title}</span>
                    <span className="text-right text-[#88847c]">1h</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="mt-10">
            <div className="mb-4 font-semibold text-[#aaa69e]">Recipes</div>
            <div className="flex max-w-[620px] flex-wrap gap-2">
              {["List recent todos", "Coach me", "Write weekly recap", "Find action items", "Blind spots", "See all"].map((recipe) => (
                <button
                  key={recipe}
                  onClick={() => setInput(recipe)}
                  className="rounded-xl border border-[#4a4945] bg-[#3a3936] px-3 py-2 font-medium transition hover:border-[#64625c] hover:bg-[#444340] hover:text-[#f0eee8]"
                >
                  <ClipboardList className="mr-2 inline h-4 w-4" />
                  {recipe}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-[860px] flex-1 flex-col pb-28 pt-20">
          <div className="flex-1 space-y-8 overflow-y-auto px-2 py-8">
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[520px] rounded-2xl bg-[#383735] px-5 py-3 text-lg text-[#f0eee8]">{message.content}</div>
                </div>
              ) : (
                <div key={message.id} className="max-w-[760px] text-lg leading-8 text-[#d7d3ca]">
                  <span className="mb-3 block font-semibold text-[#a8bf3b]">OS Notepad</span>
                  {message.content}
                </div>
              ),
            )}
            {messages.length === 0 && !thinking && (
              <div className="max-w-[760px] text-lg leading-8 text-[#d7d3ca]">
                Ask about recent notes, todos, or meeting details.
              </div>
            )}
            {thinking && (
              <div className="flex items-center gap-3 text-lg font-semibold text-[#aaa69e]">
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#626058] border-t-[#a8bf3b]" />
                Thinking...
              </div>
            )}
          </div>
          <div className="absolute bottom-6 left-1/2 w-[min(860px,calc(100%-3rem))] -translate-x-1/2">
            <ChatComposer input={input} setInput={setInput} onSubmit={onSubmit} onRecord={onRecord} />
          </div>
        </div>
      )}
    </div>
  );
}

function ChatComposer({
  input,
  setInput,
  onSubmit,
  onRecord,
  autoFocus = false,
}: {
  input: string;
  setInput: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onRecord: () => void;
  autoFocus?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [model, setModel] = useState("Auto");
  const [fileName, setFileName] = useState("");

  return (
    <form onSubmit={onSubmit} className="mt-7 rounded-[26px] border-2 border-[#596820] bg-[#343331] p-5 shadow-xl">
      <input
        value={input}
        onChange={(event) => setInput(event.target.value)}
        autoFocus={autoFocus}
        placeholder="What decisions were made?"
        className="w-full bg-transparent text-xl text-[#f0eee8] outline-none placeholder:text-[#aaa69e]"
      />
      <div className="mt-6 flex items-center justify-between text-[#aaa69e]">
        <div className="flex items-center gap-6">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 transition hover:text-[#f0eee8]"
            title={fileName || "Attach file"}
          >
            <Paperclip className="h-5 w-5" />
            {fileName && <span className="max-w-[180px] truncate text-sm">{fileName}</span>}
          </button>
          <label className="flex items-center gap-1">
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              className="bg-transparent font-semibold outline-none transition hover:text-[#f0eee8]"
              aria-label="Select model"
            >
              <option className="bg-[#2f2f2d]" value="Auto">Auto</option>
              <option className="bg-[#2f2f2d]" value="Fast">Fast</option>
              <option className="bg-[#2f2f2d]" value="Smart">Smart</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          onClick={onRecord}
          className="grid h-12 w-12 place-items-center rounded-full bg-[#4a4945] transition hover:bg-[#5a5853] hover:text-[#f0eee8]"
          aria-label="Start transcription"
        >
          <Mic className="h-5 w-5" />
        </button>
      </div>
    </form>
  );
}

function NoteView({
  note,
  question,
  setQuestion,
  onAsk,
  assistantPanel,
  onRunRecipe,
  onCloseAssistantPanel,
  folders,
  setFolders,
  onAddNoteToFolder,
  onTitleChange,
}: {
  note: Note;
  question: string;
  setQuestion: (value: string) => void;
  onAsk: (event: FormEvent) => void;
  assistantPanel: NoteAssistantPanel | null;
  onRunRecipe: (recipe: NoteRecipe) => void;
  onCloseAssistantPanel: () => void;
  folders: FolderItem[];
  setFolders: (folders: FolderItem[]) => void;
  onAddNoteToFolder: (folderId: string) => void;
  onTitleChange: (title: string) => void;
}) {
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const transcriptSeconds = Math.max(0, Math.round((note.transcript.split(/\s+/).filter(Boolean).length / 155) * 60));

  function createFolder(event: FormEvent) {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    setFolders([...folders, { id: `folder-${Date.now()}`, name, description: "", noteIds: [note.id] }]);
    setNewFolderName("");
    setFolderPickerOpen(false);
  }

  return (
    <div className="scrollbar-soft flex-1 overflow-y-auto px-6">
      <NoteDocument
        key={note.id}
        note={note}
        onAddToFolder={() => setFolderPickerOpen((open) => !open)}
        onTitleChange={onTitleChange}
      />
      {folderPickerOpen && (
        <div className="absolute left-1/2 top-36 z-30 w-[380px] -translate-x-1/2 overflow-hidden rounded-2xl border border-[#54524d] bg-[#383735] shadow-2xl">
          <div className="flex items-center gap-3 border-b border-[#4a4945] px-5 py-4 text-[#aaa69e]">
            <input className="min-w-0 flex-1 bg-transparent text-lg outline-none" placeholder="Search" />
            <Search className="h-5 w-5" />
          </div>
          <button onClick={() => setFolderPickerOpen(false)} className="flex w-full items-center justify-between px-5 py-4 text-lg transition hover:bg-[#464541]">
            <span className="flex items-center gap-3">
              <FileText className="h-6 w-6 text-[#aaa69e]" /> My notes
            </span>
            <Check className="h-5 w-5 text-[#a8bf3b]" />
          </button>
          {folders.map((folder) => (
            <button
              key={folder.id}
              onClick={() => {
                onAddNoteToFolder(folder.id);
                setFolderPickerOpen(false);
              }}
              className="flex w-full items-center gap-3 px-5 py-4 text-lg transition hover:bg-[#464541]"
            >
              <Folder className="h-6 w-6 text-[#aaa69e]" /> {folder.name}
            </button>
          ))}
          <form onSubmit={createFolder} className="flex items-center gap-3 border-t border-[#4a4945] px-5 py-4 text-[#a8bf3b]">
            <FolderPlus className="h-5 w-5" />
            <input
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-[#a8bf3b]"
              placeholder="New folder"
            />
          </form>
        </div>
      )}
      {assistantPanel && <NoteAssistantPanel panel={assistantPanel} onClose={onCloseAssistantPanel} />}
      {transcriptOpen ? (
        <TranscriptDrawer
          transcript={note.transcript}
          elapsed={transcriptSeconds}
          onToggleTranscript={() => setTranscriptOpen(false)}
          onClose={() => setTranscriptOpen(false)}
        />
      ) : (
        <form onSubmit={onAsk} className={`absolute bottom-6 left-1/2 flex w-[min(860px,calc(100%-3rem))] -translate-x-1/2 items-center gap-3 ${composerOpen ? "rounded-[32px] border border-[#4a4945] bg-[#3a3936] p-4 shadow-2xl" : ""}`}>
          <button
            type="button"
            onClick={() => setTranscriptOpen(true)}
            className="flex h-20 shrink-0 items-center gap-3 rounded-full border border-[#4a4945] bg-[#3f3e3a] px-6 text-[#aaa69e] shadow-xl"
            aria-label="Show transcript"
          >
            <WaveformIcon />
            <span>⌃</span>
          </button>
          <div className={`flex flex-1 ${composerOpen ? "flex-col gap-3" : "h-20 items-center rounded-full border border-[#4a4945] bg-[#3a3936] px-7"}`}>
            {composerOpen && (
              <div className="flex w-full flex-wrap items-center gap-5 px-2 text-lg font-semibold text-[#f0eee8]">
                {NOTE_RECIPE_PROMPTS.map((recipe) => (
                  <button key={recipe.id} type="button" onClick={() => onRunRecipe(recipe)} className="transition hover:text-[#a8bf3b]">
                    <ClipboardList className="mr-2 inline h-4 w-4" />
                    {recipe.label}
                  </button>
                ))}
              </div>
            )}
            <div className={`${composerOpen ? "flex h-20 w-full items-center rounded-full border-2 border-[#596820] bg-[#343331] px-7" : "contents"}`}>
            <input
              onFocus={() => setComposerOpen(true)}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-[#aaa69e]"
              placeholder="Ask anything"
            />
            {!composerOpen && <button type="button" onClick={() => onRunRecipe(NOTE_RECIPE_PROMPTS[0])} className="rounded-full border border-[#55534e] px-4 py-3 font-semibold">
              <ClipboardList className="mr-2 inline h-4 w-4" />
              Write follow up email
            </button>}
            {composerOpen && (
              <div className="flex items-center gap-4 text-[#aaa69e]">
                <button
                  type="submit"
                  disabled={!question.trim()}
                  className="grid h-12 w-12 place-items-center rounded-full bg-[#4a4945] transition hover:bg-[#5a5853] disabled:opacity-50"
                  aria-label="Ask note"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
            )}
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

function WaveformIcon({ live = false, level = 0 }: { live?: boolean; level?: number }) {
  const normalized = live ? Math.max(0.04, Math.min(1, level)) : 0;
  const heights = live
    ? [12 + normalized * 20, 20 + normalized * 16, 14 + normalized * 18]
    : [20, 36, 24];

  return (
    <span className={`recording-meter flex h-9 items-center gap-1 ${live ? "text-[#9abb28]" : "text-[#aaa69e]"}`} aria-hidden="true">
      {heights.map((height, index) => (
        <span
          key={index}
          className="w-1.5 rounded-full bg-current transition-[height,opacity] duration-75 ease-out"
          style={{ height, opacity: live ? 0.72 + normalized * 0.28 : 1 }}
        />
      ))}
    </span>
  );
}

function TranscriptDrawer({
  transcript,
  elapsed,
  audioLevel = 0,
  recording = false,
  onToggleTranscript,
  onResume,
  onClose,
}: {
  transcript: string;
  elapsed: number;
  audioLevel?: number;
  recording?: boolean;
  onToggleTranscript: () => void;
  onResume?: () => void;
  onClose: () => void;
}) {
  const segments = transcriptSegments(transcript);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const matches = useMemo(() => {
    if (!searchTerm.trim()) return [];
    const needle = searchTerm.trim().toLowerCase();
    return segments.flatMap((segment, segmentIndex) => {
      const count = segment.toLowerCase().split(needle).length - 1;
      return Array.from({ length: count }, (_, matchIndex) => ({ segmentIndex, matchIndex }));
    });
  }, [searchTerm, segments]);
  const activeSegmentIndex = matches[activeMatch]?.segmentIndex;

  function renderTranscriptLine(line: string, segmentIndex: number) {
    if (!searchTerm.trim()) return line;
    const escaped = searchTerm.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = line.split(new RegExp(`(${escaped})`, "ig"));
    return parts.map((part, index) =>
      part.toLowerCase() === searchTerm.trim().toLowerCase() ? (
        <mark key={`${part}-${index}`} className={segmentIndex === activeSegmentIndex ? "rounded bg-[#f5a623] px-0.5 text-[#2b2b2a]" : "rounded bg-[#6b6338] px-0.5 text-[#f4f2eb]"}>
          {part}
        </mark>
      ) : (
        part
      ),
    );
  }

  function stepMatch(direction: 1 | -1) {
    if (!matches.length) return;
    setActiveMatch((current) => (current + direction + matches.length) % matches.length);
  }

  return (
    <div className="absolute inset-x-0 bottom-6 z-20 mx-auto h-[min(58vh,650px)] w-[min(980px,calc(100%-3rem))] overflow-hidden rounded-[32px] border border-[#4b4a46] bg-[#383735] shadow-2xl">
      <div className="flex h-16 items-center justify-between px-7 text-[#aaa69e]">
        {searchOpen ? (
          <div className="flex h-11 w-[360px] items-center gap-4 rounded-full border border-[#56544f] bg-[#3d3c39] px-5">
            <input
              value={searchTerm}
              onChange={(event) => {
                setSearchTerm(event.target.value);
                setActiveMatch(0);
              }}
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-lg text-[#f0eee8] outline-none"
              placeholder="Search transcript"
            />
            <span className="text-sm">{matches.length ? `${activeMatch + 1}/${matches.length}` : "0/0"}</span>
            <button onClick={() => stepMatch(-1)} className="transition hover:text-[#f0eee8]" aria-label="Previous match">⌃</button>
            <button onClick={() => stepMatch(1)} className="transition hover:text-[#f0eee8]" aria-label="Next match">⌄</button>
            <button
              onClick={() => {
                setSearchOpen(false);
                setSearchTerm("");
                setActiveMatch(0);
              }}
              className="transition hover:text-[#f0eee8]"
              aria-label="Close transcript search"
            >
              ×
            </button>
          </div>
        ) : (
          <button onClick={() => setSearchOpen(true)} className="rounded-full p-2 transition hover:bg-[#494844] hover:text-[#f0eee8]" aria-label="Search transcript">
            <Search className="h-5 w-5" />
          </button>
        )}
        <div className="flex items-center gap-8">
          <button
            onClick={() => window.openNotepadDesktop?.recorder?.openSoundSettings()}
            className="rounded-full p-2 transition hover:bg-[#494844] hover:text-[#f0eee8]"
            aria-label="Open sound settings"
            title="Sound settings"
          >
            <SlidersHorizontal className="h-5 w-5" />
          </button>
          <button
            onClick={() => copyText(transcript)}
            className="rounded-full p-2 transition hover:bg-[#494844] hover:text-[#f0eee8]"
            aria-label="Copy transcript"
            title="Copy transcript"
          >
            <Copy className="h-5 w-5" />
          </button>
          <button onClick={onClose} className="rounded-full p-2 transition hover:bg-[#494844] hover:text-[#f0eee8]" aria-label="Hide transcript">
            <Minus className="h-6 w-6" />
          </button>
        </div>
      </div>
      <div className="h-[calc(100%-9rem)] overflow-y-auto px-6 pb-5 pt-4 text-lg leading-8 text-[#f0eee8]">
        <div className="mb-8 mt-36 text-center text-[#aaa69e]">
          <div>
            Always get consent when transcribing others. <span className="font-semibold">Learn more</span> <ChevronRight className="inline h-4 w-4" />
          </div>
          <div className="mt-8 font-mono text-xl">{formatElapsed(elapsed)}</div>
        </div>
        {segments.length ? (
          <div className="space-y-2 pb-3">
            {segments.map((line, index) => (
              <p
                key={`${line}-${index}`}
                className={`w-fit max-w-[92%] rounded-xl bg-[#4a4945] px-4 py-2 text-[#f4f2eb] ${
                  index % 3 === 1 ? "ml-auto" : index % 3 === 2 ? "mx-auto" : ""
                }`}
              >
                {renderTranscriptLine(line, index)}
              </p>
            ))}
          </div>
        ) : (
          <div className="grid h-32 place-items-center text-[#aaa69e]">Transcript will appear here when ready.</div>
        )}
      </div>
      <div className="flex h-20 items-center border-t border-[#4b4a46] px-7">
        <div className="flex items-center gap-6">
          <button
            type="button"
            onClick={onToggleTranscript}
            className="flex items-center gap-3 rounded-full text-[#aaa69e] transition hover:text-[#f0eee8]"
            aria-label="Hide transcript"
          >
            <WaveformIcon live={recording} level={recording ? audioLevel : 0} />
            <span className="text-xl leading-none">⌄</span>
          </button>
          {onResume && (
            <button
              type="button"
              onClick={onResume}
              className="text-lg font-semibold text-[#a8bf3b] transition hover:text-[#c6dc57]"
            >
              Resume
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function NoteAssistantPanel({ panel, onClose }: { panel: NoteAssistantPanel; onClose: () => void }) {
  const lines = panel.content.split("\n").filter((line) => line.trim().length > 0);

  return (
    <div className="mx-auto -mt-20 mb-32 w-full max-w-[820px] overflow-hidden rounded-[28px] border border-[#4b4a46] bg-[#363634] shadow-2xl">
      <div className="flex h-14 items-center justify-between border-b border-[#464541] px-6 text-[#aaa69e]">
        <div className="font-semibold text-[#d7d3ca]">{panel.title}</div>
        <button onClick={onClose} className="rounded-full p-2 transition hover:bg-[#464541] hover:text-[#f0eee8]" aria-label="Close note assistant">
          ×
        </button>
      </div>
      <div className="px-8 py-6 text-lg leading-8 text-[#f0eee8]">
        {panel.status === "thinking" ? (
          <div className="flex items-center gap-3 text-[#aaa69e]">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#85827b] border-t-[#a8bf3b]" />
            Working...
          </div>
        ) : panel.status === "error" ? (
          <div className="rounded-xl border border-[#6b3d3d] bg-[#372525] px-4 py-3 text-[#f1b4a8]">{panel.content}</div>
        ) : (
          <div className="space-y-3">
            {lines.map((line, index) => (
              <p key={`${line}-${index}`} className={line.startsWith("- ") ? "pl-4" : ""}>
                {line}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AudioPermissionModal({
  busy,
  onCreateDemo,
  onCreateAudio,
}: {
  busy: boolean;
  onCreateDemo: () => void;
  onCreateAudio: (audio: Blob) => void;
}) {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const [recordingState, setRecordingState] = useState<"idle" | "recording" | "ready" | "unsupported">("idle");
  const [recordedAudio, setRecordedAudio] = useState<Blob | null>(null);

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRecordingState("unsupported");
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const audio = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      setRecordedAudio(audio);
      setRecordingState("ready");
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
    recorder.start();
    setRecordingState("recording");
  }

  function stopRecording() {
    recorderRef.current?.stop();
  }

  return (
    <div className="absolute inset-0 grid place-items-center bg-[#202020]/35 backdrop-blur-sm">
      <div className="w-[min(760px,calc(100%-2rem))] rounded-[22px] border border-[#44433f] bg-[#222] p-10 shadow-2xl">
        <div className="text-sm font-semibold uppercase tracking-widest text-[#7e7a73]">Permissions</div>
        <h2 className="font-editorial mt-7 max-w-[620px] text-5xl leading-tight text-[#f0eee8]">
          Allow OS Notepad to transcribe your meetings
        </h2>
        <p className="mt-5 max-w-[630px] text-xl font-medium leading-8 text-[#aaa69e]">
          When you turn it on, OS Notepad transcribes meetings using your computer&apos;s audio. No bots join your meeting.
        </p>
        <div className="mt-10 overflow-hidden rounded-[22px] border border-[#3f3e3a] text-lg font-semibold">
          {["Transcribe my voice", "Transcribe other people's voices"].map((label) => (
            <div key={label} className="flex items-center justify-between border-b border-[#33322f] p-6 last:border-b-0">
              {label}
              <span className="grid h-12 w-12 place-items-center rounded-full bg-[#333]">
                <Check className="h-5 w-5" />
              </span>
            </div>
          ))}
        </div>
        <div className="mt-10 rounded-2xl border border-[#3f3e3a] bg-[#272727] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold text-[#f0eee8]">
                {recordingState === "recording" ? "Recording audio..." : recordingState === "ready" ? "Recording ready" : "Capture meeting audio"}
              </div>
              <div className="mt-1 text-sm text-[#aaa69e]">
                {recordingState === "unsupported"
                  ? "Your browser does not expose a recording API here. Use the desktop app with the native recorder."
                  : "Record from your microphone, then upload it for transcription."}
              </div>
            </div>
            {recordingState === "recording" ? (
              <button onClick={stopRecording} className="rounded-full bg-[#f0eee8] px-5 py-2 font-semibold text-[#333]">
                Stop
              </button>
            ) : (
              <button onClick={startRecording} className="rounded-full border border-[#55534e] px-5 py-2 font-semibold text-[#f0eee8]">
                Record
              </button>
            )}
          </div>
        </div>
        <div className="mt-10 flex flex-wrap justify-end gap-3">
          <button disabled={busy} onClick={onCreateDemo} className="rounded-full border border-[#55534e] px-7 py-3 text-lg font-semibold text-[#f0eee8]">
            Demo recording
          </button>
          <button
            disabled={busy || !recordedAudio}
            onClick={() => recordedAudio && onCreateAudio(recordedAudio)}
            className="rounded-full border-2 border-[#75851b] bg-[#f0eee8] px-7 py-3 text-lg font-semibold text-[#333] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Creating..." : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
