const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openNotepadDesktop", {
  isDesktop: true,
  platform: process.platform,
  recorder: {
    start: () => ipcRenderer.invoke("native-recorder:start"),
    stop: () => ipcRenderer.invoke("native-recorder:stop"),
    startStream: () => ipcRenderer.invoke("native-recorder:start-stream"),
    stopStream: () => ipcRenderer.invoke("native-recorder:stop-stream"),
    onAudio: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("native-recorder:audio", listener);
      return () => ipcRenderer.removeListener("native-recorder:audio", listener);
    },
    level: () => ipcRenderer.invoke("native-recorder:level"),
    readFile: (filePath) => ipcRenderer.invoke("native-recorder:read-file", filePath),
    openPermissions: () => ipcRenderer.invoke("native-recorder:open-permissions"),
    openSoundSettings: () => ipcRenderer.invoke("native-recorder:open-sound-settings"),
  },
});
