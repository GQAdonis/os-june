import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

function loadDotenv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
}

loadDotenv();

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:3100";

async function isServerReady() {
  try {
    const response = await fetch(`${baseUrl}/login`, { redirect: "manual" });
    if (!response.ok) return false;
    return (await response.text()).includes("Welcome back");
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await isServerReady()) return null;

  const port = new URL(baseUrl).port || "3000";
  const child = spawn("pnpm", ["exec", "next", "dev", "-p", port], {
    cwd: process.cwd(),
    env: process.env,
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
    if (exited) {
      throw new Error(`Dev server exited before becoming ready:\n${output}`);
    }
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

async function main() {
  const server = await ensureServer();
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(`${baseUrl}/`, { timeout: 10_000 });
    await page.waitForSelector("text=Coming up", { timeout: 10_000 });

    await page.getByRole("button", { name: "+ Quick note", exact: true }).click();
    await page.getByRole("button", { name: "Demo recording", exact: true }).click();
    await page.waitForSelector('article:has-text("Short recording")', { timeout: 10_000 });

    await page.getByPlaceholder("Ask anything").fill("What decisions were made?");
    await page.keyboard.press("Enter");
    await page.waitForResponse((response) => response.url().includes("/api/notes/") && response.url().includes("/chat"));
    await page.waitForSelector("text=Assistant:", { timeout: 20_000 });

    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.waitForSelector('a[href*="/share/"]', { timeout: 10_000 });
    const shareHref = await page.locator('a[href*="/share/"]').getAttribute("href");
    if (!shareHref) throw new Error("Share link was not rendered");

    await page.goto(shareHref, { waitUntil: "networkidle" });
    await page.waitForSelector("text=Short recording", { timeout: 10_000 });

    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await Promise.all([
      page.waitForResponse((response) => response.url().includes("/api/search")),
      page.getByPlaceholder("Search").fill("page reference"),
    ]);
    await page.waitForSelector("text=Search results", { timeout: 10_000 });

    console.log("E2E passed: login, recording, transcript chat, sharing, shared note, and search.");
  } finally {
    await browser.close();
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
