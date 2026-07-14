import { IconCheckmark2 } from "central-icons-filled/IconCheckmark2";
import { IconBubble3 } from "central-icons/IconBubble3";
import { IconBubbleAnnotation3 } from "central-icons/IconBubbleAnnotation3";
import { IconProjects } from "central-icons/IconProjects";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconFolderDelete } from "central-icons/IconFolderDelete";
import { IconFolderOpen } from "central-icons/IconFolderOpen";
import { IconPencil } from "central-icons/IconPencil";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconNoteText } from "central-icons/IconNoteText";
import { IconPageSearch } from "central-icons/IconPageSearch";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconSortArrowUpDown } from "central-icons/IconSortArrowUpDown";
import { IconTrashCan } from "central-icons/IconTrashCan";
import {
  deleteMemory,
  listMemories,
  memorySettings,
  setFolderInstructions,
  setFolderMemoryDisabled,
  updateMemory,
  type FolderDto,
  type HermesSessionInfo,
  type MemoryDto,
  type NoteListItemDto,
} from "../../lib/tauri";
import { sessionTimestamp } from "../../lib/hermes-adapter";
import {
  type DragEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { NOTE_DND_MIME } from "../../lib/dnd";
import { useDismiss } from "../../lib/use-dismiss";
import { useForcedEmptyStates } from "../../lib/empty-states-demo";
import { BreadcrumbBar } from "../ui/BreadcrumbBar";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { Switch } from "../ui/Switch";
import { MemoryRows } from "../settings/MemorySettingsSection";
import { AddNotesToFolderDialog } from "./AddNotesToFolderDialog";
import { AddSessionsToProjectDialog } from "./AddSessionsToProjectDialog";
import { CreateFolderDialog } from "./CreateFolderDialog";
import { EditFolderDialog } from "./EditFolderDialog";

const NO_FOLDERS: FolderDto[] = [];

type FoldersWorkspaceProps = {
  folders: FolderDto[];
  notes: NoteListItemDto[];
  /** Agent sessions that can be filed into projects alongside notes. */
  sessions: HermesSessionInfo[];
  /** sessionId -> project (folder) ids the session is filed under. */
  sessionFolderIds: Record<string, string[]>;
  selectedFolderId?: string;
  folderBackTarget?: {
    label: string;
    onBack: () => void;
  };
  onSelectFolder: (folderId?: string) => void;
  onCreateFolder: (name: string, description?: string) => Promise<FolderDto | undefined> | void;
  onRenameFolder: (folderId: string, name: string, description?: string) => void;
  onFolderUpdated: (folder: FolderDto) => void;
  onDeleteFolder: (folderId: string, deleteNotes: boolean) => Promise<unknown> | void;
  onCreateNote: (folderId?: string) => void;
  /** Start a fresh agent session that gets filed into this project. */
  onCreateSession: (folderId: string) => void;
  onSelectNote: (noteId: string) => void;
  onAssignNoteToFolder: (noteId: string, folderId: string) => Promise<unknown>;
  onRemoveNoteFromFolder: (noteId: string, folderId: string) => void;
  onOpenMoveDialog: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onSelectSession: (session: HermesSessionInfo) => void;
  onAssignSessionToFolder: (sessionId: string, folderId: string) => Promise<unknown>;
  onRemoveSessionFromFolder: (sessionId: string, folderId: string) => void;
  onOpenSessionMoveDialog: (sessionId: string) => void;
};

export function FoldersWorkspace(props: FoldersWorkspaceProps) {
  const { folders, selectedFolderId } = props;
  const folder = useMemo(
    () => folders.find((item) => item.id === selectedFolderId),
    [folders, selectedFolderId],
  );

  if (selectedFolderId && folder) {
    return <FolderDetail {...props} folder={folder} />;
  }
  return <FolderList {...props} />;
}

/* List view -------------------------------------------------------- */

type SortKey = "updated" | "created" | "name" | "nameDesc";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "updated", label: "Recent" },
  { value: "created", label: "Created" },
  { value: "name", label: "A to Z" },
  { value: "nameDesc", label: "Z to A" },
];

function FolderList({
  folders: allFolders,
  notes,
  sessions,
  sessionFolderIds,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onAssignNoteToFolder,
}: FoldersWorkspaceProps) {
  // __emptyStates() preview (dev console): render the page as a fresh
  // install would see it, real data untouched underneath.
  const folders = useForcedEmptyStates() ? NO_FOLDERS : allFolders;
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("updated");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const deleteFolderTarget = folders.find((f) => f.id === deleteId);
  const editFolderTarget = folders.find((f) => f.id === editId);

  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const normalizedQuery = query.trim().toLowerCase();

  const sortedAndFiltered = useMemo(() => {
    const filtered = normalizedQuery
      ? folders.filter((folder) =>
          `${folder.name} ${folder.description ?? ""}`.toLowerCase().includes(normalizedQuery),
        )
      : folders;
    return [...filtered].sort((a, b) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
          });
        case "nameDesc":
          return b.name.localeCompare(a.name, undefined, {
            sensitivity: "base",
          });
        case "created":
          return b.createdAt.localeCompare(a.createdAt);
        case "updated":
        default:
          return b.updatedAt.localeCompare(a.updatedAt);
      }
    });
  }, [folders, normalizedQuery, sort]);

  const content: ReactNode =
    sortedAndFiltered.length > 0 ? (
      <div className="folders-grid" role="list">
        {sortedAndFiltered.map((folder) => (
          <FolderCard
            key={folder.id}
            folder={folder}
            notes={notes}
            sessions={sessions}
            sessionFolderIds={sessionFolderIds}
            menuOpen={menu?.folderId === folder.id}
            onOpen={() => onSelectFolder(folder.id)}
            onDropNote={(noteId) => {
              const note = notes.find((item) => item.id === noteId);
              if (!note || (note.folderIds.length === 1 && note.folderIds[0] === folder.id)) {
                return;
              }
              void onAssignNoteToFolder(noteId, folder.id);
            }}
            onOpenMenu={(anchor) => {
              if (menu?.folderId === folder.id) {
                setMenu(null);
                return;
              }
              const rect = anchor.getBoundingClientRect();
              setMenu({
                folderId: folder.id,
                right: window.innerWidth - rect.right,
                top: rect.bottom + 4,
              });
            }}
          />
        ))}
      </div>
    ) : folders.length === 0 ? (
      <EmptyState
        label="Create your first project"
        icon={<IconFolderOpen size={28} />}
        title="Give your work a home"
        description="A project collects the meeting notes and agent sessions for one effort, so everything about it lives in one place."
        action={
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => setCreateOpen(true)}
          >
            <IconFolderAddRight size={14} />
            Create your first project
          </button>
        }
      />
    ) : (
      <div className="folders-empty">
        <p>No projects match “{query.trim()}”.</p>
      </div>
    );

  return (
    <section className="folders-workspace" aria-label="Projects">
      <header className="folders-header">
        <div className="folders-heading">
          <h1>Projects</h1>
          <p className="folders-subtitle">
            Group meeting notes and agent sessions around the work they belong to.
          </p>
        </div>
        <button
          type="button"
          className="primary-action primary-solid folders-create"
          onClick={() => setCreateOpen(true)}
        >
          <IconFolderAddRight size={14} />
          New project
        </button>
      </header>

      <div className="folders-controls">
        <label className="folders-search">
          <IconMagnifyingGlass size={14} />
          <input
            type="search"
            aria-label="Search projects"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <SortDropdown value={sort} onChange={setSort} />
      </div>

      {content}

      {menu ? (
        <FolderCardMenu
          right={menu.right}
          top={menu.top}
          folderId={menu.folderId}
          folders={folders}
          notes={notes}
          onClose={() => setMenu(null)}
          onOpen={(folderId) => {
            onSelectFolder(folderId);
            setMenu(null);
          }}
          onEdit={(folderId) => {
            setEditId(folderId);
            setMenu(null);
          }}
          onRequestDelete={(folderId) => setDeleteId(folderId)}
        />
      ) : null}

      <ConfirmDialog
        open={deleteFolderTarget !== undefined}
        onClose={() => setDeleteId(null)}
        onConfirm={() => {
          if (!deleteFolderTarget) return;
          return onDeleteFolder(deleteFolderTarget.id, false);
        }}
        title={`Delete "${deleteFolderTarget?.name ?? ""}"?`}
        description="Meeting notes and sessions in this project stay in your library."
        confirmLabel="Delete project"
        destructive
      />

      <CreateFolderDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async (name, description) => {
          await onCreateFolder(name, description);
        }}
      />
      {editFolderTarget ? (
        <EditFolderDialog
          open
          onClose={() => setEditId(null)}
          folder={editFolderTarget}
          onSave={(name, description) => onRenameFolder(editFolderTarget.id, name, description)}
        />
      ) : null}
    </section>
  );
}

function SortDropdown({ value, onChange }: { value: SortKey; onChange: (value: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useDismiss(ref, open, () => setOpen(false));

  const current = SORT_OPTIONS.find((option) => option.value === value);

  return (
    <div className="folders-sort" ref={ref}>
      <button
        type="button"
        className="folders-sort-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <IconSortArrowUpDown size={13} />
        <span>{current?.label ?? "Sort"}</span>
        <IconChevronDownSmall size={12} />
      </button>
      {open ? (
        <div className="folders-sort-menu" role="menu">
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className="folders-sort-item"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="folders-sort-check" aria-hidden>
                {option.value === value ? <IconCheckmark2 size={11} /> : null}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type MenuState = { folderId: string; right: number; top: number };

function FolderCard({
  folder,
  notes,
  sessions,
  sessionFolderIds,
  menuOpen,
  onOpen,
  onOpenMenu,
  onDropNote,
}: {
  folder: FolderDto;
  notes: NoteListItemDto[];
  sessions: HermesSessionInfo[];
  sessionFolderIds: Record<string, string[]>;
  menuOpen: boolean;
  onOpen: () => void;
  onOpenMenu: (anchor: HTMLElement) => void;
  onDropNote: (noteId: string) => void;
}) {
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const dragDepth = useRef(0);
  const [dropActive, setDropActive] = useState(false);
  const folderNotes = notes.filter((note) => note.folderIds.includes(folder.id));
  const folderSessions = sessions.filter((session) =>
    (sessionFolderIds[session.id] ?? []).includes(folder.id),
  );
  const lastUpdated = folderNotes[0]?.updatedAt ?? folder.updatedAt;

  function hasNoteData(event: DragEvent<HTMLElement>) {
    const types = event.dataTransfer.types;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === NOTE_DND_MIME) return true;
    }
    return false;
  }

  function resetDropState() {
    dragDepth.current = 0;
    setDropActive(false);
  }

  useEffect(() => {
    if (!dropActive) return;
    document.addEventListener("dragend", resetDropState);
    document.addEventListener("drop", resetDropState);
    return () => {
      document.removeEventListener("dragend", resetDropState);
      document.removeEventListener("drop", resetDropState);
    };
  }, [dropActive]);

  return (
    <article
      className="folder-card"
      data-menu-open={menuOpen}
      data-drop-active={dropActive || undefined}
      role="button"
      tabIndex={0}
      aria-label={`Open ${folder.name}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (menuButtonRef.current) onOpenMenu(menuButtonRef.current);
      }}
      onDragEnter={(event) => {
        if (!hasNoteData(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDropActive(true);
      }}
      onDragOver={(event) => {
        if (!hasNoteData(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "link";
      }}
      onDragLeave={(event) => {
        if (!hasNoteData(event)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) resetDropState();
      }}
      onDrop={(event) => {
        if (!hasNoteData(event)) return;
        event.preventDefault();
        const noteId = event.dataTransfer.getData(NOTE_DND_MIME);
        resetDropState();
        if (noteId) onDropNote(noteId);
      }}
    >
      <div className="folder-card-icon" aria-hidden>
        <IconFolder1 size={13} />
      </div>
      <div className="folder-card-body">
        <div className="folder-card-text">
          <h3 className="folder-card-title">{folder.name}</h3>
          {folder.description ? <p className="folder-card-meta">{folder.description}</p> : null}
        </div>
        <p className="folder-card-footer">
          <span className="folder-card-footer-item">
            <span className="folder-card-footer-icon" aria-hidden>
              <IconNoteText size={11} />
            </span>
            {folderNotes.length} {folderNotes.length === 1 ? "meeting note" : "meeting notes"}
          </span>
          {folderSessions.length > 0 ? (
            <>
              <span className="metadata-dot" aria-hidden />
              <span className="folder-card-footer-item">
                <span className="folder-card-footer-icon" aria-hidden>
                  <IconBubble3 size={11} />
                </span>
                {folderSessions.length} {folderSessions.length === 1 ? "session" : "sessions"}
              </span>
            </>
          ) : null}
          <span className="metadata-dot" aria-hidden />
          <span>Updated {formatRelative(lastUpdated)}</span>
        </p>
      </div>
      <button
        ref={menuButtonRef}
        type="button"
        className="folder-card-menu"
        aria-label={`Actions for ${folder.name}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenMenu(event.currentTarget);
        }}
      >
        <IconDotGrid1x3Horizontal size={14} />
      </button>
    </article>
  );
}

function FolderCardMenu({
  right,
  top,
  folderId,
  folders,
  onClose,
  onOpen,
  onEdit,
  onRequestDelete,
}: {
  right: number;
  top: number;
  folderId: string;
  folders: FolderDto[];
  notes: NoteListItemDto[];
  onClose: () => void;
  onOpen: (folderId: string) => void;
  onEdit: (folderId: string) => void;
  onRequestDelete: (folderId: string) => void;
}) {
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) return null;

  return (
    <div
      className="context-menu"
      style={{ right, top }}
      role="menu"
      onClick={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" onClick={() => onOpen(folder.id)}>
        <IconFolderOpen size={14} />
        Open
      </button>
      <button type="button" role="menuitem" onClick={() => onEdit(folder.id)}>
        <IconPencil size={14} />
        Edit details
      </button>
      <button
        type="button"
        role="menuitem"
        className="destructive"
        onClick={() => {
          onClose();
          onRequestDelete(folder.id);
        }}
      >
        <IconTrashCan size={14} />
        Delete
      </button>
    </div>
  );
}

/* Detail view ------------------------------------------------------ */

function FolderDetail({
  folder,
  folderBackTarget,
  folders,
  notes,
  sessions,
  sessionFolderIds,
  onSelectFolder,
  onRenameFolder,
  onFolderUpdated,
  onDeleteFolder,
  onCreateNote,
  onCreateSession,
  onSelectNote,
  onAssignNoteToFolder,
  onRemoveNoteFromFolder,
  onOpenMoveDialog,
  onDeleteNote,
  onSelectSession,
  onAssignSessionToFolder,
  onRemoveSessionFromFolder,
  onOpenSessionMoveDialog,
}: FoldersWorkspaceProps & { folder: FolderDto }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(folder.name);
  const [menu, setMenu] = useState<{ right: number; top: number } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addSessionsOpen, setAddSessionsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [instructionsDraft, setInstructionsDraft] = useState(folder.instructions ?? "");
  const [instructionsError, setInstructionsError] = useState<string>();
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [memoryEnabled, setMemoryEnabledState] = useState(false);
  const [memoryError, setMemoryError] = useState<string>();
  const titleRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    if (editingTitle && titleRef.current) {
      titleRef.current.focus();
      titleRef.current.select();
    }
  }, [editingTitle]);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(folder.name);
  }, [folder.name, editingTitle]);

  useEffect(() => {
    setInstructionsDraft(folder.instructions ?? "");
    setInstructionsError(undefined);
  }, [folder.id, folder.instructions]);

  useEffect(() => {
    let active = true;
    setMemories([]);
    setMemoryError(undefined);
    void Promise.all([listMemories(folder.id, false), memorySettings()])
      .then(([nextMemories, settings]) => {
        if (!active) return;
        setMemories(sortMemoriesNewestFirst(nextMemories));
        setMemoryEnabledState(settings.enabled);
        setMemoryError(undefined);
      })
      .catch((caught) => {
        if (active) setMemoryError(messageFromCaught(caught));
      });
    return () => {
      active = false;
    };
  }, [folder.id]);

  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // __emptyStates() preview (dev console): an open project renders as if it
  // held nothing, so the folder empty state is reachable too.
  const forcedEmpty = useForcedEmptyStates();

  const folderNotes = useMemo(
    () =>
      forcedEmpty
        ? []
        : notes
            .filter((note) => note.folderIds.includes(folder.id))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [notes, folder.id, forcedEmpty],
  );

  const folderSessions = useMemo(
    () =>
      forcedEmpty
        ? []
        : sessions
            .filter((session) => (sessionFolderIds[session.id] ?? []).includes(folder.id))
            .sort((a, b) => sessionTimestamp(b).localeCompare(sessionTimestamp(a))),
    [sessions, sessionFolderIds, folder.id, forcedEmpty],
  );

  const hasSessionsElsewhere = sessions.some(
    (session) => !(sessionFolderIds[session.id] ?? []).includes(folder.id),
  );

  const lastUpdated = folderNotes[0]?.updatedAt ?? folder.updatedAt;

  function commitRename() {
    const next = titleDraft.trim();
    setEditingTitle(false);
    if (!next || next === folder.name) {
      setTitleDraft(folder.name);
      return;
    }
    onRenameFolder(folder.id, next, folder.description ?? undefined);
  }

  function openMenu(anchor: HTMLElement) {
    const rect = anchor.getBoundingClientRect();
    setMenu({
      right: window.innerWidth - rect.right,
      top: rect.bottom + 4,
    });
  }

  async function saveInstructions() {
    const next = instructionsDraft.trim();
    if (next === (folder.instructions ?? "")) return;
    try {
      const updated = await setFolderInstructions(folder.id, next || undefined);
      onFolderUpdated(updated);
      setInstructionsDraft(updated.instructions ?? "");
      setInstructionsError(undefined);
    } catch (caught) {
      setInstructionsError(messageFromCaught(caught));
    }
  }

  async function toggleProjectMemory(remember: boolean) {
    try {
      const updated = await setFolderMemoryDisabled(folder.id, !remember);
      onFolderUpdated(updated);
      setMemoryError(undefined);
    } catch (caught) {
      setMemoryError(messageFromCaught(caught));
    }
  }

  async function editProjectMemory(id: string, content: string) {
    const updated = await updateMemory(id, content);
    setMemories((current) =>
      sortMemoriesNewestFirst(
        current.map((memory) => (memory.id === updated.id ? updated : memory)),
      ),
    );
  }

  async function removeProjectMemory(id: string) {
    try {
      await deleteMemory(id);
      setMemories((current) => current.filter((memory) => memory.id !== id));
      setMemoryError(undefined);
    } catch (caught) {
      setMemoryError(messageFromCaught(caught));
      throw caught;
    }
  }

  return (
    <section className="folder-detail" aria-label={folder.name}>
      <BreadcrumbBar
        backLabel={folderBackTarget?.label ?? "Back to projects"}
        onBack={folderBackTarget?.onBack ?? (() => onSelectFolder(undefined))}
        items={[
          { label: "Projects", onClick: () => onSelectFolder(undefined) },
          { label: folder.name, icon: <IconProjects size={13} /> },
        ]}
        actions={
          <button
            type="button"
            className="ghost-icon-button"
            aria-label={`Actions for ${folder.name}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => {
              event.stopPropagation();
              if (menu) {
                setMenu(null);
                return;
              }
              openMenu(event.currentTarget);
            }}
          >
            <IconDotGrid1x3Horizontal size={14} />
          </button>
        }
      />

      <div className="folder-detail-content">
        <header className="folder-detail-header">
          <FolderAddMenu
            onCreateSession={() => onCreateSession(folder.id)}
            onCreateNote={() => onCreateNote(folder.id)}
            onAddExisting={() => setAddOpen(true)}
            onAddSessions={() => setAddSessionsOpen(true)}
            hasNotesElsewhere={notes.some((note) => !note.folderIds.includes(folder.id))}
            hasSessionsElsewhere={hasSessionsElsewhere}
          />
          {editingTitle ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                commitRename();
              }}
            >
              <input
                ref={titleRef}
                className="folder-detail-title-input"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.currentTarget.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setTitleDraft(folder.name);
                    setEditingTitle(false);
                  }
                }}
              />
            </form>
          ) : (
            <h1
              className="folder-detail-title"
              tabIndex={0}
              role="button"
              aria-label="Rename project"
              onClick={() => setEditingTitle(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setEditingTitle(true);
                }
              }}
            >
              {folder.name}
            </h1>
          )}
          {folder.description ? (
            <p className="folder-detail-description">{folder.description}</p>
          ) : null}
          <p className="folder-detail-meta">
            <span className="folder-detail-meta-pill" aria-hidden>
              <IconNoteText size={12} />
            </span>
            {folderNotes.length} {folderNotes.length === 1 ? "meeting note" : "meeting notes"}
            {folderSessions.length > 0 ? (
              <>
                <span className="metadata-dot" aria-hidden />
                <span className="folder-detail-meta-pill" aria-hidden>
                  <IconBubble3 size={12} />
                </span>
                {folderSessions.length} {folderSessions.length === 1 ? "session" : "sessions"}
              </>
            ) : null}
            <span className="metadata-dot" aria-hidden />
            Updated {formatDate(lastUpdated)}
          </p>
        </header>

        <section className="folder-context-section" aria-labelledby="folder-instructions-heading">
          <h2 id="folder-instructions-heading" className="folder-notes-title">
            Instructions
          </h2>
          <div className="settings-card folder-context-card">
            <textarea
              className="folder-instructions-textarea"
              value={instructionsDraft}
              placeholder="Add instructions June should follow in this project's sessions."
              aria-label="Project instructions"
              aria-invalid={instructionsError ? true : undefined}
              onChange={(event) => {
                setInstructionsDraft(event.currentTarget.value);
                setInstructionsError(undefined);
              }}
              onBlur={() => void saveInstructions()}
            />
            {instructionsDraft.length >= 3_600 ? (
              <p
                className="folder-instructions-count"
                data-over-limit={instructionsDraft.length > 4_000 || undefined}
              >
                {instructionsDraft.length} / 4000 characters
              </p>
            ) : null}
            {instructionsError ? (
              <p className="settings-row-error" role="alert">
                {instructionsError}
              </p>
            ) : null}
          </div>
        </section>

        <section className="folder-context-section" aria-labelledby="folder-memory-heading">
          <h2 id="folder-memory-heading" className="folder-notes-title">
            Memory
          </h2>
          <div className="settings-card folder-context-card">
            <div className="settings-row folder-memory-toggle-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Remember things in this project</h3>
                <p className="settings-row-description">
                  {memoryEnabled
                    ? "June can save and use memories for this project."
                    : "Memory is turned off in Settings > Memory."}
                </p>
              </div>
              <div className="settings-row-control">
                <Switch
                  checked={!folder.memoryDisabled}
                  disabled={!memoryEnabled}
                  aria-label="Remember things in this project"
                  onCheckedChange={(remember) => void toggleProjectMemory(remember)}
                />
              </div>
            </div>
            {memories.length > 0 ? (
              <MemoryRows
                memories={memories}
                editable={memoryEnabled && !folder.memoryDisabled}
                onUpdate={editProjectMemory}
                onDelete={removeProjectMemory}
              />
            ) : (
              <p className="folder-memory-empty">No memories for this project yet.</p>
            )}
            {memoryError ? (
              <p className="settings-row-error" role="alert">
                {memoryError}
              </p>
            ) : null}
          </div>
        </section>

        {folderNotes.length > 0 || folderSessions.length > 0 ? (
          <>
            {/* Agents lead the project; the add menu lives up in the
                header, so the section rows are plain headings. */}
            {folderSessions.length > 0 ? (
              <>
                <div className="folder-actions-row">
                  <h2 className="folder-notes-title">Sessions</h2>
                </div>
                <FolderSessionList
                  folder={folder}
                  sessions={folderSessions}
                  onSelectSession={onSelectSession}
                  onOpenSessionMoveDialog={onOpenSessionMoveDialog}
                  onRemoveSessionFromFolder={onRemoveSessionFromFolder}
                />
              </>
            ) : null}
            {folderNotes.length > 0 ? (
              <>
                <div className="folder-actions-row">
                  <h2 className="folder-notes-title">Meeting notes</h2>
                </div>
                <FolderNoteList
                  folder={folder}
                  notes={folderNotes}
                  onSelectNote={onSelectNote}
                  onOpenMoveDialog={onOpenMoveDialog}
                  onRemoveNoteFromFolder={onRemoveNoteFromFolder}
                  onDeleteNote={onDeleteNote}
                />
              </>
            ) : null}
          </>
        ) : (
          <FolderEmptyState
            onCreateSession={() => onCreateSession(folder.id)}
            onCreateNote={() => onCreateNote(folder.id)}
            onAddExisting={() => setAddOpen(true)}
            onAddSessions={() => setAddSessionsOpen(true)}
            hasNotesElsewhere={notes.some((note) => !note.folderIds.includes(folder.id))}
            hasSessionsElsewhere={hasSessionsElsewhere}
          />
        )}
      </div>

      {menu ? (
        <div
          className="context-menu"
          style={{ right: menu.right, top: menu.top }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              setEditOpen(true);
            }}
          >
            <IconPencil size={14} />
            Edit details
          </button>
          <button
            type="button"
            role="menuitem"
            className="destructive"
            onClick={() => {
              setMenu(null);
              setDeleteOpen(true);
            }}
          >
            <IconTrashCan size={14} />
            Delete project
          </button>
        </div>
      ) : null}

      <AddNotesToFolderDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        folder={folder}
        notes={notes}
        onAdd={async (noteId) => {
          await onAssignNoteToFolder(noteId, folder.id);
        }}
      />
      <AddSessionsToProjectDialog
        open={addSessionsOpen}
        onClose={() => setAddSessionsOpen(false)}
        folder={folder}
        sessions={sessions}
        sessionFolderIds={sessionFolderIds}
        onAdd={async (sessionId) => {
          await onAssignSessionToFolder(sessionId, folder.id);
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => onDeleteFolder(folder.id, false)}
        title={`Delete "${folder.name}"?`}
        description="Meeting notes and sessions in this project stay in your library."
        confirmLabel="Delete project"
        destructive
      />
      <EditFolderDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        folder={folder}
        onSave={(name, description) => onRenameFolder(folder.id, name, description)}
      />
    </section>
  );
}

function FolderNoteList({
  folder,
  notes,
  onSelectNote,
  onOpenMoveDialog,
  onRemoveNoteFromFolder,
  onDeleteNote,
}: {
  folder: FolderDto;
  notes: NoteListItemDto[];
  onSelectNote: (noteId: string) => void;
  onOpenMoveDialog: (noteId: string) => void;
  onRemoveNoteFromFolder: (noteId: string, folderId: string) => void;
  onDeleteNote: (noteId: string) => void;
}) {
  return (
    <ul className="folder-notes" role="list">
      {notes.map((note) => (
        <FolderNoteRow
          key={note.id}
          note={note}
          folder={folder}
          onSelect={() => onSelectNote(note.id)}
          onOpenMove={() => onOpenMoveDialog(note.id)}
          onRemoveFromFolder={() => onRemoveNoteFromFolder(note.id, folder.id)}
          onDelete={() => onDeleteNote(note.id)}
        />
      ))}
    </ul>
  );
}

function FolderSessionList({
  folder,
  sessions,
  onSelectSession,
  onOpenSessionMoveDialog,
  onRemoveSessionFromFolder,
}: {
  folder: FolderDto;
  sessions: HermesSessionInfo[];
  onSelectSession: (session: HermesSessionInfo) => void;
  onOpenSessionMoveDialog: (sessionId: string) => void;
  onRemoveSessionFromFolder: (sessionId: string, folderId: string) => void;
}) {
  return (
    <ul className="folder-notes" role="list">
      {sessions.map((session) => (
        <FolderSessionRow
          key={session.id}
          session={session}
          onSelect={() => onSelectSession(session)}
          onOpenMove={() => onOpenSessionMoveDialog(session.id)}
          onRemoveFromFolder={() => onRemoveSessionFromFolder(session.id, folder.id)}
        />
      ))}
    </ul>
  );
}

function FolderSessionRow({
  session,
  onSelect,
  onOpenMove,
  onRemoveFromFolder,
}: {
  session: HermesSessionInfo;
  onSelect: () => void;
  onOpenMove: () => void;
  onRemoveFromFolder: () => void;
}) {
  const [menu, setMenu] = useState<{ right: number; top: number } | null>(null);
  const title = session.title?.trim() || session.preview?.trim() || "Untitled session";

  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <li>
      <div className="folder-note-row" data-has-actions="true" data-menu-open={menu !== null}>
        <button type="button" className="folder-note-main" onClick={onSelect}>
          <span className="folder-note-icon" aria-hidden>
            <IconBubble3 size={15} />
          </span>
          <span className="folder-note-body">
            <span className="folder-note-title">{title}</span>
            <span className="folder-note-subtitle">
              {session.preview?.trim() || "No messages yet"}
            </span>
          </span>
        </button>
        <span className="folder-note-time">{formatNoteTime(sessionTimestamp(session))}</span>
        <span className="folder-note-actions">
          <button
            type="button"
            className="folder-note-menu"
            aria-label={`Actions for ${title}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (menu) {
                setMenu(null);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({
                right: window.innerWidth - rect.right,
                top: rect.bottom + 4,
              });
            }}
          >
            <IconDotGrid1x3Horizontal size={13} />
          </button>
        </span>
        {menu ? (
          <div
            className="context-menu"
            style={{ right: menu.right, top: menu.top }}
            role="menu"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onOpenMove();
              }}
            >
              <IconMoveFolder size={14} />
              Change project
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onRemoveFromFolder();
              }}
            >
              <IconFolderDelete size={14} />
              Remove from project
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** Single "+" up in the project header — one menu for everything that can
 * land in the project, mirroring the sidebar's new-session entry point. */
function FolderAddMenu({
  onCreateSession,
  onCreateNote,
  onAddExisting,
  onAddSessions,
  hasNotesElsewhere,
  hasSessionsElsewhere,
}: {
  onCreateSession: () => void;
  onCreateNote: () => void;
  onAddExisting: () => void;
  onAddSessions: () => void;
  hasNotesElsewhere: boolean;
  hasSessionsElsewhere: boolean;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function close() {
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="folder-detail-add">
      <button
        type="button"
        className="folder-add-trigger"
        aria-label="Add to project"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <IconPlusMedium size={15} />
      </button>
      {open ? (
        <div
          className="folder-add-popover"
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onCreateSession();
            }}
          >
            <IconBubble3 size={14} />
            New session
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onCreateNote();
            }}
          >
            <IconNoteText size={14} />
            New meeting note
          </button>
          {hasNotesElsewhere || hasSessionsElsewhere ? (
            <div className="context-menu-separator" role="separator" />
          ) : null}
          {/* Session first, note second — matching the New items above. */}
          {hasSessionsElsewhere ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAddSessions();
              }}
            >
              <IconBubbleAnnotation3 size={14} />
              Add existing session
            </button>
          ) : null}
          {hasNotesElsewhere ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAddExisting();
              }}
            >
              <IconPageSearch size={14} />
              Add existing meeting note
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FolderEmptyActions({
  onCreateSession,
  onCreateNote,
  onAddExisting,
  onAddSessions,
  hasNotesElsewhere,
  hasSessionsElsewhere,
}: {
  onCreateSession: () => void;
  onCreateNote: () => void;
  onAddExisting: () => void;
  onAddSessions: () => void;
  hasNotesElsewhere: boolean;
  hasSessionsElsewhere: boolean;
}) {
  return (
    <div className="folder-empty-actions">
      {hasSessionsElsewhere ? (
        <button type="button" className="primary-action" onClick={onAddSessions}>
          Add existing session
        </button>
      ) : null}
      {hasNotesElsewhere ? (
        <button type="button" className="primary-action" onClick={onAddExisting}>
          Add existing meeting note
        </button>
      ) : null}
      <button type="button" className="primary-action" onClick={onCreateSession}>
        <IconBubble3 size={13} />
        New session
      </button>
      <button type="button" className="primary-action primary-solid" onClick={onCreateNote}>
        <IconPlusMedium size={13} />
        New meeting note
      </button>
    </div>
  );
}

function FolderNoteRow({
  note,
  folder: _folder,
  onSelect,
  onOpenMove,
  onRemoveFromFolder,
  onDelete,
}: {
  note: NoteListItemDto;
  folder: FolderDto;
  onSelect: () => void;
  onOpenMove: () => void;
  onRemoveFromFolder: () => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState<{ right: number; top: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <li>
      <div className="folder-note-row" data-has-actions="true" data-menu-open={menu !== null}>
        <button type="button" className="folder-note-main" onClick={onSelect}>
          <span className="folder-note-icon" aria-hidden>
            <IconNoteText size={14} />
          </span>
          <span className="folder-note-body">
            <span className="folder-note-title">{note.title.trim() || "New note"}</span>
            <span className="folder-note-subtitle">
              {note.preview.trim() ? note.preview : `Updated ${formatRelative(note.updatedAt)}`}
            </span>
          </span>
        </button>
        <span className="folder-note-time">{formatNoteTime(note.updatedAt)}</span>
        <span className="folder-note-actions">
          <button
            type="button"
            className="folder-note-menu"
            aria-label={`Actions for ${note.title.trim() || "this meeting note"}`}
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (menu) {
                setMenu(null);
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({
                right: window.innerWidth - rect.right,
                top: rect.bottom + 4,
              });
            }}
          >
            <IconDotGrid1x3Horizontal size={13} />
          </button>
        </span>
        {menu ? (
          <div
            className="context-menu"
            style={{ right: menu.right, top: menu.top }}
            role="menu"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onOpenMove();
              }}
            >
              <IconMoveFolder size={14} />
              Change project
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onRemoveFromFolder();
              }}
            >
              <IconFolderDelete size={14} />
              Remove from project
            </button>
            <div className="context-menu-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="destructive"
              onClick={() => {
                setMenu(null);
                setConfirmDelete(true);
              }}
            >
              <IconTrashCan size={14} />
              Delete meeting note
            </button>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={onDelete}
        title={`Delete "${note.title.trim() || "New note"}"?`}
        description="This cannot be undone."
        confirmLabel="Delete meeting note"
        destructive
      />
    </li>
  );
}

function FolderEmptyState({
  onCreateSession,
  onCreateNote,
  onAddExisting,
  onAddSessions,
  hasNotesElsewhere,
  hasSessionsElsewhere,
}: {
  onCreateSession: () => void;
  onCreateNote: () => void;
  onAddExisting: () => void;
  onAddSessions: () => void;
  hasNotesElsewhere: boolean;
  hasSessionsElsewhere: boolean;
}) {
  return (
    <div className="folder-empty-surface" role="group">
      <p className="folder-empty-hint">
        Capture a meeting, a phone call, or a half-formed thought. Or start an agent session on this
        project.
      </p>
      <FolderEmptyActions
        onCreateSession={onCreateSession}
        onCreateNote={onCreateNote}
        onAddExisting={onAddExisting}
        onAddSessions={onAddSessions}
        hasNotesElsewhere={hasNotesElsewhere}
        hasSessionsElsewhere={hasSessionsElsewhere}
      />
    </div>
  );
}

/* Formatting helpers ----------------------------------------------- */

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

function sortMemoriesNewestFirst(memories: MemoryDto[]) {
  return [...memories].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function messageFromCaught(caught: unknown) {
  if (caught && typeof caught === "object" && "message" in caught) {
    return String((caught as { message: unknown }).message);
  }
  return String(caught);
}

/** Right-aligned timestamp inside a folder's note row. Same-day shows
 * just the time ("2:09 PM"). Within a week, the weekday ("Mon"). Older,
 * the date ("May 22"). */
function formatNoteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays < 7) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
