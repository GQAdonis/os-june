import { existsSync, readFileSync } from "node:fs";
import { OpenAiProvider } from "@/lib/providers/ai";
import { GoogleCalendarProvider } from "@/lib/providers/calendar";
import { MockBillingProvider, StripeBillingProvider } from "@/lib/providers/billing";
import { OpenAICompatibleTranscriptionProvider, OpenAITranscriptionProvider } from "@/lib/providers/transcription";

function loadDotenv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
}

function requireEnv(keys: string[]) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required real-provider environment variables: ${missing.join(", ")}`);
  }
}

function getMissingEnv(keys: string[]) {
  return keys.filter((key) => !process.env[key]);
}

async function verifyOpenAI() {
  requireEnv(["OPENAI_API_KEY"]);
  const provider = new OpenAiProvider(process.env.OPENAI_API_KEY, process.env.OPENAI_MODEL || "gpt-4o-mini");
  const summary = await provider.summarizeTranscript("Jun said the team decided to ship the OS Notepad workflow today.");
  if (!summary.toLowerCase().includes("ship")) {
    throw new Error("OpenAI summary did not reflect the transcript decision");
  }
  const answer = await provider.answerQuestion({ question: "What decision was made?" });
  if (!answer.trim()) {
    throw new Error("OpenAI transcript chat returned an empty answer");
  }
  console.log("OpenAI provider: live check passed");
}

async function verifyStripeConfig() {
  requireEnv(["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID"]);
  const provider = new StripeBillingProvider(process.env.STRIPE_SECRET_KEY, process.env.STRIPE_PRICE_ID);
  await provider.verifyConfiguration();
  console.log("Stripe provider: live configuration check passed");
}

async function verifyBilling() {
  if (process.env.BILLING_PROVIDER === "stripe") {
    await verifyStripeConfig();
    return;
  }

  const provider = new MockBillingProvider();
  const checkout = await provider.createCheckout({
    workspaceId: "mock_billing_smoke",
    workspaceSlug: "mock-billing-smoke",
    workspaceName: "Mock Billing Smoke",
    customerEmail: "billing-smoke@example.com",
    appUrl: process.env.APP_URL || "http://localhost:3000",
  });
  if (checkout.status !== "active") {
    throw new Error("Mock billing did not return an active checkout result");
  }
  console.log("Mock billing provider: check passed");
}

function verifyGoogleConfig() {
  requireEnv(["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REDIRECT_URI"]);
  const provider = new GoogleCalendarProvider(
    process.env.GOOGLE_CALENDAR_CLIENT_ID,
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    process.env.GOOGLE_CALENDAR_REDIRECT_URI,
  );
  const url = provider.getAuthorizationUrl("real_provider_smoke");
  if (!url.includes("accounts.google.com")) throw new Error("Google provider did not create an OAuth URL");
  console.log("Google Calendar provider: OAuth URL check passed");
}

async function verifyHttpTranscriptionConfig() {
  requireEnv(["TRANSCRIPTION_BASE_URL"]);
  const provider = new OpenAICompatibleTranscriptionProvider({
    baseUrl: process.env.TRANSCRIPTION_BASE_URL!,
    apiKey: process.env.TRANSCRIPTION_API_KEY,
    model: process.env.TRANSCRIPTION_MODEL || "whisper-1",
  });
  const audioFile = new File(["real-provider-smoke"], "smoke.webm", { type: "audio/webm" });
  const result = await provider.transcribe({ title: "Real provider smoke", audioFile });
  if (!result.transcript || !result.turns.length) {
    throw new Error("HTTP transcription provider returned an invalid result");
  }
  console.log("HTTP transcription provider: live check passed");
}

async function verifyOpenAITranscription() {
  requireEnv(["OPENAI_API_KEY"]);
  const speech = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: "Jun decided to ship the OS Notepad workflow.",
      response_format: "mp3",
    }),
  });
  if (!speech.ok) throw new Error(`OpenAI speech generation failed: ${speech.status}`);
  const audioFile = new File([await speech.blob()], "openai-transcription-smoke.mp3", { type: "audio/mpeg" });
  const provider = new OpenAITranscriptionProvider(process.env.OPENAI_API_KEY, process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe");
  const result = await provider.transcribe({ title: "OpenAI transcription smoke", audioFile });
  const normalizedTranscript = result.transcript.toLowerCase().replace(/\s+/g, "");
  if (!normalizedTranscript.includes("opennotepad")) {
    throw new Error(`OpenAI transcription did not include expected content: ${result.transcript}`);
  }
  console.log("OpenAI transcription provider: live check passed");
}

async function main() {
  loadDotenv();

  await verifyOpenAI();
  await verifyOpenAITranscription();

  if (process.env.REQUIRE_ALL_REAL_PROVIDERS === "true") {
    const missing = [
      ...getMissingEnv(["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REDIRECT_URI"]),
      ...(process.env.BILLING_PROVIDER === "stripe" ? getMissingEnv(["STRIPE_SECRET_KEY", "STRIPE_PRICE_ID"]) : []),
      ...(process.env.TRANSCRIPTION_PROVIDER === "openai-compatible" ? getMissingEnv(["TRANSCRIPTION_BASE_URL"]) : []),
    ];
    if (missing.length) {
      throw new Error(`Missing required real-provider environment variables: ${missing.join(", ")}`);
    }
    verifyGoogleConfig();
    await verifyBilling();
    if (process.env.TRANSCRIPTION_PROVIDER === "openai-compatible") {
      await verifyHttpTranscriptionConfig();
    }
  } else {
    console.log("Skipping Google/Stripe/transcription live checks. Set REQUIRE_ALL_REAL_PROVIDERS=true to require them.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
