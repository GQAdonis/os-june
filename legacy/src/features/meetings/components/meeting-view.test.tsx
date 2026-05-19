import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingView } from "@/features/meetings/components/meeting-view";

afterEach(() => {
  cleanup();
});

describe("MeetingView", () => {
  it("shows transcript, working notes, and the end action", () => {
    render(
      <MeetingView
        title="Planning meeting"
        elapsedSeconds={65}
        audioLevel={0.4}
        transcript="Microphone: Jun approved the launch."
        summary={"# Working Summary\n- Jun approved the launch."}
        status="recording"
        error={null}
        onEnd={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Planning meeting" })).toBeInTheDocument();
    expect(screen.getByText("01:05")).toBeInTheDocument();
    expect(screen.getByText("Microphone: Jun approved the launch.")).toBeInTheDocument();
    expect(screen.getByTestId("meeting-transcript-scroll")).toHaveClass("overflow-y-auto");
    expect(screen.getByText("Working Summary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End Meeting" })).toBeEnabled();
  });

  it("keeps empty meetings editable instead of finalizing without transcript text", () => {
    const onEnd = vi.fn();
    render(
      <MeetingView
        title="Planning meeting"
        elapsedSeconds={10}
        audioLevel={0}
        transcript=""
        summary=""
        status="recording"
        error={null}
        onEnd={onEnd}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "End Meeting" }));

    expect(onEnd).not.toHaveBeenCalled();
    expect(screen.getByText("Wait for the first transcript text before generating final notes.")).toBeInTheDocument();
  });

  it("allows live meetings to end before the first transcript event so realtime can flush audio", () => {
    const onEnd = vi.fn();
    render(
      <MeetingView
        title="Planning meeting"
        elapsedSeconds={10}
        audioLevel={0}
        transcript=""
        summary=""
        status="recording"
        error={null}
        allowEmptyTranscriptEnd
        onEnd={onEnd}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "End Meeting" }));

    expect(onEnd).toHaveBeenCalled();
  });
});
