import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:3300";

function loadDotenv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
}

async function isServerReady() {
  try {
    const response = await fetch(`${baseUrl}/api/bootstrap`, { redirect: "manual" });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isServerReady()) return null;
  const port = new URL(baseUrl).port || "3000";
  const child = spawn("pnpm", ["exec", "next", "dev", "-p", port], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_URL: baseUrl,
      AI_PROVIDER: "openai",
      TRANSCRIPTION_PROVIDER: "openai",
    },
    stdio: "pipe",
  });
  let exited = false;
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.on("exit", () => {
    exited = true;
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isServerReady()) return child;
    if (exited) throw new Error(`Dev server exited before becoming ready:\n${output}`);
    await delay(500);
  }
  child.kill();
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function stopServer(child: ChildProcess | null) {
  if (!child) return;
  child.kill();
  await delay(250);
}

async function createSpeechAudio() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for real OpenAI recording E2E");
  }
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: "Jun decided to ship the OS Notepad workflow today. Adrian will write the follow up email.",
      response_format: "mp3",
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI speech generation failed: ${response.status}`);
  }
  return new File([await response.blob()], "real-openai-recording.mp3", { type: "audio/mpeg" });
}

async function main() {
  loadDotenv();
  const server = await ensureServer();
  try {
    const authResponse = await fetch(`${baseUrl}/api/auth/demo`, { method: "POST" });
    const cookie = authResponse.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) {
      throw new Error("Demo auth did not return a session cookie");
    }
    const audio = await createSpeechAudio();
    const form = new FormData();
    form.set("title", "Real OpenAI recording");
    form.set("audio", audio);

    const recordingResponse = await fetch(`${baseUrl}/api/recordings`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });
    if (!recordingResponse.ok) {
      throw new Error(`Recording upload failed: ${recordingResponse.status} ${await recordingResponse.text()}`);
    }
    const recording = (await recordingResponse.json()) as { note: { id: string; transcript: string; summary: string } };
    if (!recording.note.transcript.toLowerCase().includes("open notepad")) {
      throw new Error(`Unexpected transcript: ${recording.note.transcript}`);
    }
    if (!recording.note.summary.trim()) {
      throw new Error("AI summary was empty");
    }

    const chatResponse = await fetch(`${baseUrl}/api/notes/${recording.note.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ question: "What did Jun decide?" }),
    });
    if (!chatResponse.ok) {
      throw new Error(`Transcript chat failed: ${chatResponse.status} ${await chatResponse.text()}`);
    }
    const chat = (await chatResponse.json()) as { message: { content: string } };
    if (!chat.message.content.toLowerCase().includes("ship")) {
      throw new Error(`Unexpected chat answer: ${chat.message.content}`);
    }

    console.log("Real OpenAI recording E2E passed: TTS audio, transcription, summary, and transcript chat.");
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
