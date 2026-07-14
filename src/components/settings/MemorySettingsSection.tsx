import { IconPencilLine } from "central-icons/IconPencilLine";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconTrashCanSimple } from "central-icons/IconTrashCanSimple";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  createMemory,
  deleteMemory,
  listMemories,
  memorySettings,
  setMemoryEnabled,
  updateMemory,
  type FolderDto,
  type MemoryDto,
} from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog, DialogField } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { SettingsPageHeader } from "./AppSettings";

const GLOBAL_SCOPE = "__all-projects__";
const MEMORY_MAX_CHARS = 4_000;

export function MemorySettingsSection({ folders }: { folders: FolderDto[] }) {
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    try {
      const [nextMemories, settings] = await Promise.all([
        listMemories(undefined, true),
        memorySettings(),
      ]);
      setMemories(sortNewestFirst(nextMemories));
      setEnabled(settings.enabled);
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setLoaded(true);
    }
  }

  async function toggleEnabled(next: boolean) {
    try {
      const settings = await setMemoryEnabled(next);
      setEnabled(settings.enabled);
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function addMemory(content: string, folderId?: string) {
    const created = await createMemory({ content, folderId, source: "user" });
    setMemories((current) => sortNewestFirst([created, ...current]));
  }

  async function editMemory(id: string, content: string) {
    const updated = await updateMemory(id, content);
    setMemories((current) =>
      sortNewestFirst(current.map((memory) => (memory.id === updated.id ? updated : memory))),
    );
  }

  async function removeMemory(id: string) {
    try {
      await deleteMemory(id);
      setMemories((current) => current.filter((memory) => memory.id !== id));
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
      throw caught;
    }
  }

  const groups = useMemo(() => memoryGroups(memories, folders), [memories, folders]);

  return (
    <section className="settings-group memory-settings" aria-labelledby="memory-heading">
      <SettingsPageHeader
        id="memory-heading"
        title="Memory"
        blurb="See and manage what June remembers. Memories stay on this Mac."
      />

      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Let June remember things</h3>
            <p className="settings-row-description">
              June can save useful details across sessions and use them when they are relevant.
            </p>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={enabled}
              disabled={!loaded}
              aria-label="Let June remember things"
              onCheckedChange={(next) => void toggleEnabled(next)}
            />
          </div>
        </div>
      </div>

      {!enabled && loaded ? (
        <p className="memory-settings-hint">
          Memory is off. Saved memories remain visible, but June cannot add or update them.
        </p>
      ) : null}

      <div className="memory-settings-actions">
        <button
          type="button"
          className="primary-action primary-solid"
          disabled={!enabled || !loaded}
          onClick={() => setAddOpen(true)}
        >
          <IconPlusMedium size={14} />
          Add memory
        </button>
      </div>

      {groups.length === 0 && loaded ? (
        <div className="settings-card memory-empty">
          <p>No memories yet. June can remember useful details as you work together.</p>
        </div>
      ) : (
        groups.map((group) => (
          <section className="memory-group" key={group.folder?.id ?? GLOBAL_SCOPE}>
            <div className="memory-group-heading-row">
              <h2 className="settings-group-heading">{group.label}</h2>
              {group.folder?.memoryDisabled ? (
                <span className="memory-project-off">Memory off for this project</span>
              ) : null}
            </div>
            <div className="settings-card">
              <MemoryRows
                memories={group.memories}
                editable={enabled && !group.folder?.memoryDisabled}
                onUpdate={editMemory}
                onDelete={removeMemory}
              />
            </div>
          </section>
        ))
      )}
      {error ? (
        <p className="settings-row-error" role="alert">
          {error}
        </p>
      ) : null}

      <MemoryDialog
        open={addOpen}
        title="Add memory"
        submitLabel="Add memory"
        folders={folders}
        onClose={() => setAddOpen(false)}
        onSubmit={async (content, folderId) => {
          await addMemory(content, folderId);
          setAddOpen(false);
        }}
      />
    </section>
  );
}

export function MemoryRows({
  memories,
  editable,
  onUpdate,
  onDelete,
}: {
  memories: MemoryDto[];
  editable: boolean;
  onUpdate: (id: string, content: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<MemoryDto>();
  const [deleting, setDeleting] = useState<MemoryDto>();
  const [error, setError] = useState<string>();

  return (
    <>
      <div className="settings-rows memory-rows">
        {memories.map((memory) => {
          const expanded = expandedIds.has(memory.id);
          return (
            <div key={memory.id} className="settings-row settings-row-compact memory-row">
              <div className="settings-row-info">
                <button
                  type="button"
                  className="memory-content"
                  data-expanded={expanded || undefined}
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedIds((current) => {
                      const next = new Set(current);
                      if (next.has(memory.id)) next.delete(memory.id);
                      else next.add(memory.id);
                      return next;
                    })
                  }
                >
                  {memory.content}
                </button>
                <p className="settings-row-description memory-source">
                  {memory.source === "agent" ? "Added by June" : "Added by you"}
                </p>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Edit memory"
                  disabled={!editable}
                  onClick={() => setEditing(memory)}
                >
                  <IconPencilLine size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button icon-button-destructive"
                  aria-label="Delete memory"
                  onClick={() => setDeleting(memory)}
                >
                  <IconTrashCanSimple size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {error ? (
        <p className="settings-row-error" role="alert">
          {error}
        </p>
      ) : null}

      <MemoryDialog
        open={editing !== undefined}
        title="Edit memory"
        submitLabel="Save changes"
        initialContent={editing?.content}
        onClose={() => {
          setEditing(undefined);
          setError(undefined);
        }}
        onSubmit={async (content) => {
          if (!editing) return;
          try {
            await onUpdate(editing.id, content);
            setEditing(undefined);
            setError(undefined);
          } catch (caught) {
            setError(messageFromError(caught));
            throw caught;
          }
        }}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        title="Delete memory?"
        description="This permanently removes this memory from June."
        confirmLabel="Delete"
        destructive
        onClose={() => setDeleting(undefined)}
        onConfirm={async () => {
          if (!deleting) return;
          await onDelete(deleting.id);
        }}
      />
    </>
  );
}

function MemoryDialog({
  open,
  title,
  submitLabel,
  initialContent = "",
  folders,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  initialContent?: string;
  folders?: FolderDto[];
  onClose: () => void;
  onSubmit: (content: string, folderId?: string) => Promise<void>;
}) {
  const [content, setContent] = useState(initialContent);
  const [scope, setScope] = useState(GLOBAL_SCOPE);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setContent(initialContent);
    setScope(GLOBAL_SCOPE);
    setError(undefined);
  }, [open, initialContent]);

  function handleClose() {
    if (saving) return;
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onSubmit(trimmed, folders && scope !== GLOBAL_SCOPE ? scope : undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={title}
      initialFocusSelector='textarea[name="memory-content"]'
      footer={
        <>
          <button type="button" className="primary-action" disabled={saving} onClick={handleClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="memory-entry-form"
            className="primary-action primary-solid"
            disabled={saving || content.trim().length === 0}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <form id="memory-entry-form" className="dialog-body" onSubmit={handleSubmit}>
        <DialogField label="Memory" htmlFor="memory-content">
          <textarea
            id="memory-content"
            name="memory-content"
            className="dialog-textarea"
            value={content}
            maxLength={MEMORY_MAX_CHARS}
            onChange={(event) => {
              setContent(event.currentTarget.value);
              setError(undefined);
            }}
          />
        </DialogField>
        {folders ? (
          <DialogField label="Project">
            <Select
              value={scope}
              options={[
                { value: GLOBAL_SCOPE, label: "None (all projects)" },
                ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
              ]}
              placeholder="None (all projects)"
              ariaLabel="Memory project"
              onChange={setScope}
              popoverWidth="trigger"
            />
          </DialogField>
        ) : null}
        {error ? (
          <p className="settings-row-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

function memoryGroups(memories: MemoryDto[], folders: FolderDto[]) {
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const global = memories.filter((memory) => !memory.folderId);
  const grouped = new Map<string, MemoryDto[]>();
  for (const memory of memories) {
    if (!memory.folderId) continue;
    const current = grouped.get(memory.folderId) ?? [];
    current.push(memory);
    grouped.set(memory.folderId, current);
  }

  return [
    ...(global.length > 0
      ? [{ label: "All projects", folder: undefined, memories: sortNewestFirst(global) }]
      : []),
    ...[...grouped.entries()]
      .map(([folderId, entries]) => ({
        label: folderById.get(folderId)?.name ?? "Unknown project",
        folder: folderById.get(folderId),
        memories: sortNewestFirst(entries),
      }))
      .sort((left, right) =>
        left.label.localeCompare(right.label, undefined, { sensitivity: "base" }),
      ),
  ];
}

function sortNewestFirst(memories: MemoryDto[]) {
  return [...memories].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function messageFromError(caught: unknown) {
  if (caught && typeof caught === "object" && "message" in caught) {
    return String((caught as { message: unknown }).message);
  }
  return String(caught);
}
