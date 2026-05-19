"use client";

import { useState } from "react";

type NoteWithRelations = {
  id: string;
  title: string;
  summary: string;
  date?: string | Date;
  transcript?: string;
  turns?: unknown[];
  messages?: unknown[];
};

function renderInlineMarkdown(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={`${part}-${index}`} className="font-semibold text-[#cbc8bf]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

function renderMarkdown(markdown: string) {
  const lines = markdown
    .split("\n")
    .filter((line) => !/^\s*Chat with meeting transcript:/i.test(line))
    .filter((line) => !/^\s*#{0,6}\s*Date:\s*\[.*\]\s*$/i.test(line))
    .filter((line) => !/^\s*#{0,6}\s*Participants:\s*\[.*\]\s*$/i.test(line));
  const nodes: React.ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length) {
      nodes.push(
        <ul key={`ul-${nodes.length}`} className="mb-7 list-disc space-y-3 pl-7">
          {listItems.map((item) => (
            <li key={item}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
      listItems = [];
    }
  };

  lines.forEach((line, index) => {
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    const listItem = line.match(/^\s*[-*]\s+(.+)$/);

    if (heading) {
      flushList();
      nodes.push(
        <h2 key={`h-${index}`} className="mb-4 mt-8 text-[1.35rem] font-semibold leading-8 text-[#cbc8bf]">
          {renderInlineMarkdown(heading[1])}
        </h2>,
      );
    } else if (listItem) {
      listItems.push(listItem[1]);
    } else if (line.trim()) {
      flushList();
      nodes.push(
        <p key={`p-${index}`} className="mb-5 leading-8 text-[#aaa6a0]">
          {renderInlineMarkdown(line.trim())}
        </p>,
      );
    }
  });
  flushList();
  return nodes;
}

export function NoteDocument({
  note,
  readOnly = false,
  onAddToFolder,
  onTitleChange,
}: {
  note: NoteWithRelations;
  readOnly?: boolean;
  onAddToFolder?: () => void;
  onTitleChange?: (title: string) => void;
}) {
  const titleIsPlaceholder = note.title === "New note";
  const [title, setTitle] = useState(titleIsPlaceholder ? "" : note.title);

  function commitTitle() {
    const nextTitle = title.trim() || "New note";
    if (nextTitle !== note.title) onTitleChange?.(nextTitle);
  }

  return (
    <article className="mx-auto w-full max-w-[760px] pb-36 pt-14">
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={commitTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        readOnly={readOnly}
        placeholder="New note"
        className={`w-full bg-transparent font-editorial text-[clamp(2rem,4vw,3.15rem)] leading-tight outline-none placeholder:text-[#817e77] ${
          title.trim() ? "text-[#f0eee7]" : "text-[#817e77]"
        }`}
        aria-label="Note title"
      />
      <div className="mt-7 flex flex-wrap gap-2 text-sm font-medium text-[#9d9a93]">
        <span className="rounded-full border border-[#42413e] px-3 py-2">Today</span>
        <span className="rounded-full border border-[#42413e] px-3 py-2">Me</span>
        {!readOnly && (
          <button onClick={onAddToFolder} className="rounded-full border border-[#42413e] px-3 py-2 transition hover:bg-[#343331] hover:text-[#f0eee8]">
            Add to folder
          </button>
        )}
      </div>
      <div className="markdown-note mt-9 text-[1.35rem]">{renderMarkdown(note.summary)}</div>
    </article>
  );
}
