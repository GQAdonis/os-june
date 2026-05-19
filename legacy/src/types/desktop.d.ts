export {};

declare global {
  interface Window {
    openNotepadDesktop?: {
      isDesktop: boolean;
      platform: string;
      recorder?: {
        start: () => Promise<{ ok: boolean; outputPath?: string; error?: string }>;
        stop: () => Promise<{ ok: boolean; outputPath?: string; error?: string }>;
        startStream: () => Promise<{ ok: boolean; error?: string }>;
        stopStream: () => Promise<{ ok: boolean; error?: string }>;
        onAudio: (
          callback: (payload: { data: string; sampleRate: number; channels: number }) => void,
        ) => () => void;
        level: () => Promise<{ ok: boolean; level?: number; error?: string }>;
        readFile: (filePath: string) => Promise<{ ok: boolean; data?: string; error?: string }>;
        openPermissions: () => Promise<{ ok: boolean }>;
        openSoundSettings: () => Promise<{ ok: boolean }>;
      };
    };
  }
}
