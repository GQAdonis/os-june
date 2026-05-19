"use client";

import { Square } from "lucide-react";
import { useState } from "react";

type MeetingViewStatus = "recording" | "ending" | "ended";

export function MeetingView({
  title,
  elapsedSeconds,
  audioLevel,
  transcript,
  summary,
  status,
  error,
  allowEmptyTranscriptEnd = false,
  onEnd,
}: {
  title: string;
  elapsedSeconds: number;
  audioLevel: number;
  transcript: string;
  summary: string;
  status: MeetingViewStatus;
  error: string | null;
  allowEmptyTranscriptEnd?: boolean;
  onEnd: () => void;
}) {
  const ending = status === "ending";
  const [localWarning, setLocalWarning] = useState<string | null>(null);
  const warning = localWarning || error;
  const canFinalize = allowEmptyTranscriptEnd || transcript.trim().length > 0;

  function handleEnd() {
    if (!canFinalize) {
      setLocalWarning("Wait for the first transcript text before generating final notes.");
      return;
    }
    setLocalWarning(null);
    onEnd();
  }

  return (
    <div className="scrollbar-soft flex-1 overflow-y-auto px-6 pb-28 pt-6 text-[#d8d4cc]">
      <div className="mx-auto grid w-full max-w-[1180px] gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <section className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="font-editorial text-4xl text-[#f0eee8]">{title}</h1>
              <div className="mt-3 flex items-center gap-4 text-sm font-semibold text-[#aaa69e]">
                <span className="font-mono text-[#c8c5bd]">{formatMeetingElapsed(elapsedSeconds)}</span>
                <span className="flex items-center gap-2">
                  <span className="h-2.5 w-24 overflow-hidden rounded-full bg-[#4a4945]">
                    <span className="block h-full rounded-full bg-[#9abb28]" style={{ width: `${Math.round(Math.max(0, Math.min(1, audioLevel)) * 100)}%` }} />
                  </span>
                  Recording
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleEnd}
              disabled={ending || status === "ended"}
              className="inline-flex h-11 items-center gap-2 rounded-full bg-[#c8c6bf] px-4 font-semibold text-[#2b2b2a] transition hover:bg-[#e2ded4] disabled:opacity-60"
            >
              <Square className="h-4 w-4 fill-current" />
              {ending ? "Ending..." : "End Meeting"}
            </button>
          </div>

          {warning && (
            <div className="mt-5 rounded-xl border border-[#6b5a2c] bg-[#352d1f] px-4 py-3 text-[#d8c690]">
              {warning}
            </div>
          )}

          <div className="mt-8 flex min-h-[56vh] flex-col rounded-xl border border-[#3f3e3a] bg-[#30302e] p-5">
            <div className="mb-3 text-sm font-semibold uppercase tracking-[0.12em] text-[#8f8b84]">Transcript</div>
            {transcript.trim() ? (
              <div data-testid="meeting-transcript-scroll" className="scrollbar-soft max-h-[52vh] overflow-y-auto whitespace-pre-wrap pr-2 text-lg leading-8 text-[#f0eee8]">
                {transcript}
              </div>
            ) : (
              <div className="grid h-40 place-items-center text-[#8f8b84]">Transcript will appear as audio is transcribed.</div>
            )}
          </div>
        </section>

        <aside className="min-w-0 rounded-xl border border-[#3f3e3a] bg-[#343331] p-5">
          <div className="mb-4 text-sm font-semibold uppercase tracking-[0.12em] text-[#8f8b84]">Working notes</div>
          {summary.trim() ? (
            <div className="space-y-3 text-base leading-7 text-[#c9c6bd]">{renderMeetingSummary(summary)}</div>
          ) : (
            <div className="grid h-40 place-items-center text-center text-[#8f8b84]">Notes update as transcript text is processed.</div>
          )}
        </aside>
      </div>
    </div>
  );
}

function formatMeetingElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function renderMeetingSummary(markdown: string) {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        return (
          <h2 key={`${line}-${index}`} className="pt-2 text-lg font-semibold text-[#f0eee8]">
            {heading[1]}
          </h2>
        );
      }
      const listItem = line.match(/^[-*]\s+(.+)$/);
      return <p key={`${line}-${index}`}>{listItem?.[1] || line}</p>;
    });
}
