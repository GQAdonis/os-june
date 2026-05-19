import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { NoteDocument } from "@/components/note-document";

export default async function SharedNotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const share = await prisma.share.findUnique({
    where: { token },
    include: { note: { include: { turns: true, messages: true } } },
  });

  if (!share) notFound();

  return (
    <main className="min-h-screen bg-[#252525] px-6 py-12 text-[#efeee8]">
      <div className="mx-auto max-w-3xl">
        <NoteDocument note={share.note} readOnly />
      </div>
    </main>
  );
}
