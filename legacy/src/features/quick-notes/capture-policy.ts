export type QuickNoteCapturePlan = {
  microphone: true;
  systemAudio: false;
};

export function getQuickNoteCapturePlan(): QuickNoteCapturePlan {
  return {
    microphone: true,
    systemAudio: false,
  };
}
