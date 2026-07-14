import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySettingsSection } from "../components/settings/MemorySettingsSection";
import type { FolderDto, MemoryDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  listMemories: vi.fn(),
  memorySettings: vi.fn(),
  setMemoryEnabled: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauri")>();
  return { ...actual, ...mocks };
});

const folders: FolderDto[] = [
  {
    id: "project-a",
    name: "Alpha",
    memoryDisabled: false,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  },
  {
    id: "project-b",
    name: "Beta",
    memoryDisabled: true,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  },
];

const memories: MemoryDto[] = [
  {
    id: "global",
    content: "Use concise answers",
    source: "user",
    createdAt: "2026-07-03T00:00:00Z",
    updatedAt: "2026-07-03T00:00:00Z",
  },
  {
    id: "alpha",
    folderId: "project-a",
    content: "Launch day is Friday",
    source: "agent",
    createdAt: "2026-07-04T00:00:00Z",
    updatedAt: "2026-07-04T00:00:00Z",
  },
  {
    id: "beta",
    folderId: "project-b",
    content: "The budget is approved",
    source: "user",
    createdAt: "2026-07-02T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMemories.mockResolvedValue(memories);
  mocks.memorySettings.mockResolvedValue({ enabled: true });
  mocks.setMemoryEnabled.mockImplementation(async (enabled: boolean) => ({ enabled }));
  mocks.createMemory.mockImplementation(
    async ({ folderId, content }: { folderId?: string; content: string }) => ({
      id: "created",
      folderId,
      content,
      source: "user",
      createdAt: "2026-07-05T00:00:00Z",
      updatedAt: "2026-07-05T00:00:00Z",
    }),
  );
  mocks.updateMemory.mockImplementation(async (id: string, content: string) => {
    const memory = memories.find((candidate) => candidate.id === id);
    if (!memory) throw new Error("Missing test memory");
    return { ...memory, content };
  });
  mocks.deleteMemory.mockResolvedValue(undefined);
});

describe("MemorySettingsSection", () => {
  it("renders global memories first, project groups, sources, and project-off state", async () => {
    render(<MemorySettingsSection folders={folders} />);

    expect(await screen.findByText("Use concise answers")).toBeInTheDocument();
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["Memory", "All projects", "Alpha", "Beta"]);
    expect(screen.getByText("Added by June")).toBeInTheDocument();
    expect(screen.getAllByText("Added by you")).toHaveLength(2);
    expect(screen.getByText("Memory off for this project")).toBeInTheDocument();
  });

  it("adds, edits, and deletes memories through the bindings", async () => {
    const user = userEvent.setup();
    render(<MemorySettingsSection folders={folders} />);
    await screen.findByText("Use concise answers");

    await user.click(screen.getByRole("button", { name: "Add memory" }));
    const addDialog = screen.getByRole("dialog", { name: "Add memory" });
    await user.type(within(addDialog).getByRole("textbox", { name: "Memory" }), "Call Sam");
    await user.click(within(addDialog).getByRole("button", { name: "Memory project" }));
    await user.click(screen.getByRole("option", { name: "Alpha" }));
    await user.click(within(addDialog).getByRole("button", { name: "Add memory" }));
    await waitFor(() =>
      expect(mocks.createMemory).toHaveBeenCalledWith({
        content: "Call Sam",
        folderId: "project-a",
        source: "user",
      }),
    );

    await user.click(screen.getAllByRole("button", { name: "Edit memory" })[0]);
    const editDialog = screen.getByRole("dialog", { name: "Edit memory" });
    const editField = within(editDialog).getByRole("textbox", { name: "Memory" });
    await user.clear(editField);
    await user.type(editField, "Use very concise answers");
    await user.click(within(editDialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(mocks.updateMemory).toHaveBeenCalledWith("global", "Use very concise answers"),
    );

    await user.click(screen.getAllByRole("button", { name: "Delete memory" })[0]);
    const deleteDialog = screen.getByRole("dialog", { name: "Delete memory?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.deleteMemory).toHaveBeenCalledWith("global"));
  });

  it("wires the global toggle and keeps saved memories inspectable while off", async () => {
    mocks.memorySettings.mockResolvedValueOnce({ enabled: false });
    const user = userEvent.setup();
    render(<MemorySettingsSection folders={folders} />);

    expect(await screen.findByText("Use concise answers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add memory" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Edit memory" })[0]).toBeDisabled();
    expect(
      screen.getByText(
        "Memory is off. Saved memories remain visible, but June cannot add or update them.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Let June remember things" }));
    expect(mocks.setMemoryEnabled).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add memory" })).toBeEnabled());
  });
});
