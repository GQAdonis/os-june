CREATE TABLE "TranscriptChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "noteId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "startSec" INTEGER NOT NULL,
    "endSec" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TranscriptChunk_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TranscriptChunk_noteId_source_index_key" ON "TranscriptChunk"("noteId", "source", "index");

CREATE INDEX "TranscriptChunk_noteId_index_idx" ON "TranscriptChunk"("noteId", "index");
