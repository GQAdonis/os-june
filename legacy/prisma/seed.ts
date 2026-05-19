import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { hash } from "bcryptjs";

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "file:./prisma/dev.db" });
const prisma = new PrismaClient({ adapter });

async function main() {
  const seedEmail = process.env.SEED_USER_EMAIL?.trim();
  const seedPassword = process.env.SEED_USER_PASSWORD;
  const seedName = process.env.SEED_USER_NAME?.trim() || "Local User";

  if (!seedEmail || !seedPassword) {
    console.log("Skipping seed data. Set SEED_USER_EMAIL and SEED_USER_PASSWORD to create local fixtures.");
    return;
  }

  const passwordHash = await hash(seedPassword, 10);

  const user = await prisma.user.upsert({
    where: { email: seedEmail },
    update: {},
    create: {
      email: seedEmail,
      name: seedName,
      passwordHash,
      avatarUrl: "/avatar.svg",
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { slug: "jun-team" },
    update: {},
    create: {
      name: `${seedName}'s notes`,
      slug: "jun-team",
      plan: "BASIC",
      memberships: { create: { userId: user.id, role: "OWNER" } },
      spaces: {
        create: [
          { name: "My notes", icon: "lock" },
          { name: "Jun team", icon: "team" },
        ],
      },
    },
    include: { spaces: true },
  });

  if (!workspace.spaces.length) {
    await prisma.space.createMany({
      data: [
        { name: "My notes", icon: "lock", workspaceId: workspace.id },
        { name: "Jun team", icon: "team", workspaceId: workspace.id },
      ],
    });
  }

  const spaces = await prisma.space.findMany({ where: { workspaceId: workspace.id } });
  const myNotes = spaces.find((space) => space.name === "My notes") ?? spaces[0];

  const shortRecording = await prisma.note.upsert({
    where: { id: "seed-short-recording" },
    update: {},
    create: {
      id: "seed-short-recording",
      title: "Short recording",
      status: "READY",
      visibility: "PRIVATE",
      workspaceId: workspace.id,
      spaceId: myNotes.id,
      ownerId: user.id,
      date: new Date("2026-05-12T18:54:00Z"),
      summary: [
        "# Meeting Setup",
        "- Brief recording session initiated",
        "- Introductory exchange between participants",
        "",
        "# Participant Introduction",
        "- Jun identified himself by name",
        "- Expressed appreciation for goatee (unclear context)",
        "",
        "# Meeting Context",
        "- Adrian mentioned as meeting participant",
        "- Page referenced (unclear meaning, possibly surname or document reference)",
        "",
        "# Status",
        "- Very brief interaction captured",
        "- Limited substantive content recorded",
        "- May require follow-up for complete documentation",
      ].join("\n"),
      transcript:
        "Jun: Hey, this is a short recording. Adrian, thanks for joining.\nAdrian: Happy to help. Let us capture the setup and follow up later.",
      turns: {
        create: [
          { speaker: "Jun", text: "Hey, this is a short recording. Adrian, thanks for joining.", startSec: 0, endSec: 8 },
          { speaker: "Adrian", text: "Happy to help. Let us capture the setup and follow up later.", startSec: 9, endSec: 17 },
        ],
      },
    },
  });

  await prisma.note.upsert({
    where: { id: "seed-family-meeting" },
    update: {},
    create: {
      id: "seed-family-meeting",
      title: "Family Meeting for Financial Decisions",
      status: "READY",
      visibility: "PRIVATE",
      workspaceId: workspace.id,
      spaceId: myNotes.id,
      ownerId: user.id,
      date: new Date("2024-06-27T00:06:00Z"),
      summary: "# Decisions\n- Review budget next Friday\n- Keep shared receipts in one folder",
      transcript: "We discussed shared expenses, savings goals, and follow-up timing.",
    },
  });

  let connection = await prisma.calendarConnection.findUnique({ where: { workspaceId: workspace.id } });
  if (!connection) {
    connection = await prisma.calendarConnection.create({
      data: {
        workspaceId: workspace.id,
        provider: "mock-google",
        providerUserId: user.email,
      },
    });
  }

  const eventCount = await prisma.calendarEvent.count({ where: { connectionId: connection.id } });
  if (eventCount === 0) {
    await prisma.calendarEvent.createMany({
      data: [
        {
          connectionId: connection.id,
          title: "engineering sync",
          startsAt: new Date("2026-05-13T12:45:00Z"),
          endsAt: new Date("2026-05-13T13:00:00Z"),
          attendees: "Matt, Adrian",
        },
        {
          connectionId: connection.id,
          title: "universal sync",
          startsAt: new Date("2026-05-13T13:00:00Z"),
          endsAt: new Date("2026-05-13T13:30:00Z"),
          attendees: "Product Team",
        },
        {
          connectionId: connection.id,
          title: "Shuta : Jun",
          startsAt: new Date("2026-05-13T16:00:00Z"),
          endsAt: new Date("2026-05-13T16:30:00Z"),
          attendees: "Shuta",
        },
        {
          connectionId: connection.id,
          title: "Alongside Exec Team Meeting",
          startsAt: new Date("2026-05-13T17:00:00Z"),
          endsAt: new Date("2026-05-13T17:45:00Z"),
          attendees: "Exec Team",
        },
        {
          connectionId: connection.id,
          title: "engineering sync",
          startsAt: new Date("2026-05-14T12:45:00Z"),
          endsAt: new Date("2026-05-14T13:00:00Z"),
          attendees: "Engineering",
        },
      ],
    });
  }

  await prisma.chatMessage.upsert({
    where: { id: "seed-chat-message" },
    update: {},
    create: {
      id: "seed-chat-message",
      noteId: shortRecording.id,
      userId: user.id,
      role: "assistant",
      content: "The recording captured a short meeting setup and a few participant references.",
    },
  });
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
