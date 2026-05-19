import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoteDocument } from "@/components/note-document";

describe("NoteDocument", () => {
  it("renders markdown-style headings and bullets", () => {
    render(
      <NoteDocument
        note={{
          id: "note-1",
          title: "Short recording",
          summary: "# Decisions\n- Ship the prototype\n- Verify the UI",
        }}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Short recording");
    expect(screen.getByText("Ship the prototype")).toBeInTheDocument();
    expect(screen.getByText("Verify the UI")).toBeInTheDocument();
  });
});
