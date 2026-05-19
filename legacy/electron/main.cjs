const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const { fork, spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const isDev = !app.isPackaged;
const defaultPort = Number(process.env.PORT || 3000);
let serverProcess = null;
let mainWindow = null;
let recorderProcess = null;
let recorderOutputPath = null;
let recorderStatusPath = null;
let recorderPidPath = null;
let recorderSystemLevel = 0;
let recorderMode = null;
let recorderStreamServer = null;
let recorderStreamSawFirstAudio = false;
const minNativeRecordingBytes = 4096;

function getFreePort(startPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", () => resolve(getFreePort(startPort + 1)));
  });
}

async function waitForServer(url, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (response.ok || response.status < 500) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function ensureProductionDatabase() {
  const userData = app.getPath("userData");
  const dbPath = path.join(userData, "os-notepad.db");
  if (!fs.existsSync(dbPath)) {
    const seedDb = path.join(process.resourcesPath, "app", "dev.db");
    if (fs.existsSync(seedDb)) {
      fs.copyFileSync(seedDb, dbPath);
    }
  }
  process.env.DATABASE_URL = `file:${dbPath}`;
}

function getRecorderAppPath() {
  const installedAppPath = "/Applications/OS Notepad.app";
  if (fs.existsSync(installedAppPath)) return installedAppPath;
  if (isDev) {
    return path.join(__dirname, "..", "native", "bin", "OS Notepad.app");
  }
  return path.join(process.resourcesPath, "native", "bin", "OS Notepad.app");
}

function getRecorderExecutablePath() {
  return path.join(getRecorderAppPath(), "Contents", "MacOS", "os-notepad-recorder");
}

function parseRecorderLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function stopRecorderProcess() {
  if (recorderProcess && !recorderProcess.killed) {
    recorderProcess.kill("SIGINT");
  }
  if (recorderPidPath && fs.existsSync(recorderPidPath)) {
    const pid = Number(fs.readFileSync(recorderPidPath, "utf8").trim());
    if (pid) {
      try {
        process.kill(pid, "SIGINT");
      } catch {
        // Process may already be stopped.
      }
    }
  }
  if (recorderStreamServer) {
    recorderStreamServer.close();
    recorderStreamServer = null;
  }
}

function readRecorderStatus() {
  if (!recorderStatusPath || !fs.existsSync(recorderStatusPath)) return null;
  return parseRecorderLine(fs.readFileSync(recorderStatusPath, "utf8"));
}

function waitForRecorderStatus(expectedEvents, timeoutMs = 15000) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const poll = () => {
      const status = readRecorderStatus();
      if (status && expectedEvents.includes(status.event)) {
        resolve(status);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        resolve({ event: "error", message: "Timed out waiting for native recorder." });
        return;
      }
      setTimeout(poll, 150);
    };
    poll();
  });
}

ipcMain.handle("native-recorder:start", async () => {
  return startNativeRecorder({ mode: "file" });
});

ipcMain.handle("native-recorder:start-stream", async () => {
  return startNativeRecorder({ mode: "stream" });
});

async function startNativeRecorder({ mode }) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Native system audio capture is only implemented for macOS." };
  }
  if (recorderProcess) {
    if (recorderMode === mode) return { ok: true, outputPath: recorderOutputPath || undefined };
    return { ok: false, error: "Native system audio capture is already running." };
  }
  recorderSystemLevel = 0;
  recorderMode = mode;
  recorderStreamSawFirstAudio = false;

  const recorderAppPath = getRecorderAppPath();
  const recorderExecutablePath = getRecorderExecutablePath();
  if (!fs.existsSync(recorderExecutablePath)) {
    return { ok: false, error: `Native recorder helper was not found at ${recorderExecutablePath}` };
  }

  const outputDir = path.join(app.getPath("temp"), "os-notepad-recordings");
  fs.mkdirSync(outputDir, { recursive: true });
  recorderOutputPath = mode === "file" ? path.join(outputDir, `quick-note-${Date.now()}.wav`) : null;
  recorderStatusPath = path.join(outputDir, `quick-note-${Date.now()}.status.json`);
  recorderPidPath = path.join(outputDir, `quick-note-${Date.now()}.pid`);
  fs.rmSync(recorderStatusPath, { force: true });
  fs.rmSync(recorderPidPath, { force: true });

  const streamPort = mode === "stream" ? await startRecorderStreamServer() : null;
  const recorderArgs =
    mode === "stream"
      ? ["-n", "-W", recorderAppPath, "--args", "--stream", "--stream-port", String(streamPort), "--status", recorderStatusPath, "--pid", recorderPidPath]
      : ["-n", "-W", recorderAppPath, "--args", "--output", recorderOutputPath, "--status", recorderStatusPath, "--pid", recorderPidPath];

  recorderProcess = spawn(
    "/usr/bin/open",
    recorderArgs,
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const readyPromise = new Promise((resolve) => {
    let settled = false;

    const settle = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    recorderProcess.stdout.on("data", (chunk) => {
      handleRecorderOutput(chunk.toString(), settle);
    });

    recorderProcess.stderr.on("data", (chunk) => {
      console.error(`[native-recorder] ${chunk}`);
    });

    recorderProcess.on("exit", (code) => {
      recorderProcess = null;
      recorderMode = null;
      if (recorderStreamServer) {
        recorderStreamServer.close();
        recorderStreamServer = null;
      }
      if (!settled && code !== 0) {
        settle({ ok: false, error: "Native recorder exited before it was ready." });
      }
    });
  });

  const status = await waitForRecorderStatus(["ready", "error"]);
  if (status.event === "ready") return { ok: true, outputPath: recorderOutputPath || undefined };
  const fallback = await Promise.race([readyPromise, Promise.resolve(null)]);
  return fallback || { ok: false, error: status.message || "Native recorder failed to start." };
}

function handleRecorderOutput(text, settle) {
  for (const line of text.trim().split("\n")) {
    const event = parseRecorderLine(line);
    handleRecorderEvent(event, settle);
  }
}

function handleRecorderEvent(event, settle) {
  if (event?.event === "level" && typeof event.level === "number") {
    recorderSystemLevel = Math.max(0, Math.min(1, event.level));
  }
  if (event?.event === "audio" && typeof event.data === "string") {
    if (!recorderStreamSawFirstAudio) {
      recorderStreamSawFirstAudio = true;
      console.log("[native-recorder] first system audio chunk received");
    }
    mainWindow?.webContents.send("native-recorder:audio", {
      data: event.data,
      sampleRate: typeof event.sampleRate === "number" ? event.sampleRate : 24000,
      channels: typeof event.channels === "number" ? event.channels : 1,
    });
  }
  if (event?.event === "ready") {
    settle?.({ ok: true, outputPath: recorderOutputPath || undefined });
  }
  if (event?.event === "error") {
    settle?.({ ok: false, error: event.message || "Native recorder failed to start." });
  }
}

function startRecorderStreamServer() {
  return new Promise((resolve, reject) => {
    let streamBuffer = "";
    const server = net.createServer((socket) => {
      console.log("[native-recorder] system audio stream connected");
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        streamBuffer += chunk;
        const lines = streamBuffer.split("\n");
        streamBuffer = lines.pop() || "";
        for (const line of lines) {
          handleRecorderEvent(parseRecorderLine(line));
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      recorderStreamServer = server;
      const address = server.address();
      resolve(address.port);
    });
  });
}

ipcMain.handle("native-recorder:stop", async () => {
  if (!recorderProcess || !recorderOutputPath) {
    return { ok: false, error: "Native recorder is not running." };
  }

  const outputPath = recorderOutputPath;
  const child = recorderProcess;

  return new Promise((resolve) => {
    const finish = () => {
      recorderProcess = null;
      recorderOutputPath = null;
      recorderStatusPath = null;
      recorderPidPath = null;
      recorderSystemLevel = 0;
      recorderMode = null;
      if (recorderStreamServer) {
        recorderStreamServer.close();
        recorderStreamServer = null;
      }
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > minNativeRecordingBytes) {
        resolve({ ok: true, outputPath });
      } else {
        resolve({ ok: false, error: "Native recorder did not produce an audio file." });
      }
    };

    child.once("exit", finish);
    stopRecorderProcess();
  });
});

ipcMain.handle("native-recorder:stop-stream", async () => {
  if (!recorderProcess || recorderMode !== "stream") {
    return { ok: false, error: "Native system audio stream is not running." };
  }

  const child = recorderProcess;
  return new Promise((resolve) => {
    child.once("exit", () => {
      recorderProcess = null;
      recorderOutputPath = null;
      recorderStatusPath = null;
      recorderPidPath = null;
      recorderSystemLevel = 0;
      recorderMode = null;
      if (recorderStreamServer) {
        recorderStreamServer.close();
        recorderStreamServer = null;
      }
      resolve({ ok: true });
    });
    stopRecorderProcess();
  });
});

ipcMain.handle("native-recorder:level", async () => {
  return { ok: true, level: recorderSystemLevel };
});

ipcMain.handle("native-recorder:read-file", async (_event, filePath) => {
  const allowedDir = path.join(app.getPath("temp"), "os-notepad-recordings");
  if (!filePath || !path.resolve(filePath).startsWith(path.resolve(allowedDir))) {
    return { ok: false, error: "File path is outside the recorder output directory." };
  }
  return { ok: true, data: fs.readFileSync(filePath).toString("base64") };
});

ipcMain.handle("native-recorder:open-permissions", async () => {
  await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  return { ok: true };
});

ipcMain.handle("native-recorder:open-sound-settings", async () => {
  await shell.openExternal("x-apple.systempreferences:com.apple.preference.sound");
  return { ok: true };
});

async function startProductionServer() {
  ensureProductionDatabase();
  const port = await getFreePort(defaultPort);
  const serverPath = path.join(process.resourcesPath, "app", ".next", "standalone", "server.js");

  serverProcess = fork(serverPath, [], {
    cwd: path.join(process.resourcesPath, "app"),
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    },
    stdio: "pipe",
  });

  serverProcess.on("exit", (code) => {
    if (code && !app.isQuitting) app.quit();
  });

  const url = `http://127.0.0.1:${port}`;
  await waitForServer(`${url}/login`);
  return url;
}

async function createWindow() {
  const appUrl = isDev ? process.env.ELECTRON_START_URL || "http://localhost:3000" : await startProductionServer();

  mainWindow = new BrowserWindow({
    width: 1460,
    height: 980,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: "#232323",
    title: "OS Notepad",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(appUrl)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(appUrl);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    const isLocalApp = url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:");
    callback(isLocalApp && ["media", "audioCapture"].includes(permission));
  });
  createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  stopRecorderProcess();
  if (serverProcess) serverProcess.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
