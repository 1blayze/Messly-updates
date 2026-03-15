export interface MicrophoneCaptureOptions {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  channelCount?: number;
}

const DEFAULT_MIC_OPTIONS: Required<MicrophoneCaptureOptions> = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

export async function captureMicrophoneStream(
  options: MicrophoneCaptureOptions = DEFAULT_MIC_OPTIONS,
): Promise<MediaStream> {
  const constraints: MediaTrackConstraints = {
    echoCancellation: options.echoCancellation ?? DEFAULT_MIC_OPTIONS.echoCancellation,
    noiseSuppression: options.noiseSuppression ?? DEFAULT_MIC_OPTIONS.noiseSuppression,
    autoGainControl: options.autoGainControl ?? DEFAULT_MIC_OPTIONS.autoGainControl,
    channelCount: options.channelCount ?? DEFAULT_MIC_OPTIONS.channelCount,
  };

  return navigator.mediaDevices.getUserMedia({
    video: false,
    audio: constraints,
  });
}

export function stopMediaStream(stream: MediaStream | null | undefined): void {
  if (!stream) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export function setAudioTrackMuted(stream: MediaStream | null | undefined, muted: boolean): void {
  if (!stream) {
    return;
  }

  for (const track of stream.getAudioTracks()) {
    track.enabled = !muted;
  }
}

export function attachRemoteAudioPlayback(
  stream: MediaStream,
  userId: string,
  targetMap: Map<string, HTMLAudioElement>,
): HTMLAudioElement {
  const existing = targetMap.get(userId);
  if (existing) {
    if (existing.srcObject !== stream) {
      existing.srcObject = stream;
    }
    return existing;
  }

  const audioElement = new Audio();
  audioElement.autoplay = true;
  audioElement.setAttribute("playsinline", "true");
  audioElement.srcObject = stream;
  targetMap.set(userId, audioElement);
  void audioElement.play().catch(() => {
    // Ignore autoplay policies; playback will resume after user interaction.
  });
  return audioElement;
}

export function removeRemoteAudioPlayback(userId: string, targetMap: Map<string, HTMLAudioElement>): void {
  const audioElement = targetMap.get(userId);
  if (!audioElement) {
    return;
  }

  audioElement.pause();
  audioElement.srcObject = null;
  targetMap.delete(userId);
}

export function clearRemoteAudioPlayback(targetMap: Map<string, HTMLAudioElement>): void {
  for (const [userId] of targetMap) {
    removeRemoteAudioPlayback(userId, targetMap);
  }
}
