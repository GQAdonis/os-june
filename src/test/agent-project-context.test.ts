import { describe, expect, it } from "vitest";
import { prepareProjectPrompt, type AgentProjectContext } from "../lib/agent-project-context";

const project: AgentProjectContext = {
  id: "project-1",
  name: "Launch",
  instructions: "Prefer concise updates.",
};

describe("agent project context", () => {
  it("injects the context block on the first project prompt", () => {
    const prepared = prepareProjectPrompt("What changed?", project, undefined);

    expect(prepared.injected).toBe(true);
    expect(prepared.text).toBe(
      "[June project context]\n" +
        "project_id: project-1\n" +
        "project: Launch\n" +
        "instructions:\n" +
        "Prefer concise updates.\n" +
        "[/June project context]\n\n" +
        "What changed?",
    );
  });

  it("does not inject the unchanged project twice", () => {
    const first = prepareProjectPrompt("First", project, undefined);
    const second = prepareProjectPrompt("Second", project, first.contextSignature);

    expect(second).toEqual({
      text: "Second",
      injected: false,
      contextSignature: first.contextSignature,
    });
  });

  it("injects again after the session filing changes", () => {
    const first = prepareProjectPrompt("First", project, undefined);
    const moved = prepareProjectPrompt(
      "After move",
      { ...project, id: "project-2", name: "Research" },
      first.contextSignature,
    );

    expect(moved.injected).toBe(true);
    expect(moved.text).toContain("project_id: project-2");
    expect(moved.text).toContain("project: Research");
  });

  it("injects again after project instructions change", () => {
    const first = prepareProjectPrompt("First", project, undefined);
    const changed = prepareProjectPrompt(
      "After edit",
      { ...project, instructions: "Use primary sources." },
      first.contextSignature,
    );

    expect(changed.injected).toBe(true);
    expect(changed.text).toContain("instructions:\nUse primary sources.");
  });

  it("does not inject for a session outside a project", () => {
    expect(prepareProjectPrompt("Global question", undefined, undefined)).toEqual({
      text: "Global question",
      injected: false,
      contextSignature: null,
    });
  });
});
