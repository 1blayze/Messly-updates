export interface MicrophoneCaptureOptions {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  channelCount?: number;
  deviceId?: string | null;
  inputVolumePercent?: number | null;
}

const DEFAULT_MIC_OPTIONS: Required<MicrophoneCaptureOptions> = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  deviceId: "",
  inputVolumePercent: 100,
};

export async function captureMicrophoneStream(
  options: MicrophoneCaptureOptions = DEFAULT_MIC_OPTIONS,
): Promise<MediaStream> {
  const normalizedDeviceId = String(options.deviceId ?? "").trim();
  const requestedInputVolumePercent = Number(options.inputVolumePercent ?? 100);
  const normalizedInputVolume = Number.isFinite(requestedInputVolumePercent)
    ? Math.max(0, Math.min(100, requestedInputVolumePercent)) / 100
    : 1;

  const constraints: MediaTrackConstraints = {
    echoCancellation: options.echoCancellation ?? DEFAULT_MIC_OPTIONS.echoCancellation,
    noiseSuppression: options.noiseSuppression ?? DEFAULT_MIC_OPTIONS.noiseSuppression,
    autoGainControl: options.autoGainControl ?? DEFAULT_MIC_OPTIONS.autoGainControl,
    channelCount: options.channelCount ?? DEFAULT_MIC_OPTIONS.channelCount,
  };
  (constraints as MediaTrackConstraints & { volume?: number }).volume = normalizedInputVolume;

  const constraintsWithDevice: MediaTrackConstraints = normalizedDeviceId
    ? {
        ...constraints,
        deviceId: {
          exact: normalizedDeviceId,
        },
      }
    : constraints;

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: constraintsWithDevice,
    });
  } catch (error) {
    if (!normalizedDeviceId) {
      throw error;
    }

    // Fall back to default device if the saved device ID is no longer available.
    return navigator.mediaDevices.getUserMedia({
      video: false,
      audio: constraints,
    });
  }
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
  options?: {
    outputDeviceId?: string | null;
    outputVolumePercent?: number | null;
  },
): HTMLAudioElement {
  const existing = targetMap.get(userId);
  if (existing) {
    if (existing.srcObject !== stream) {
      existing.srcObject = stream;
    }
    applyRemoteAudioOptions(existing, options);
    return existing;
  }

  const audioElement = new Audio();
  audioElement.autoplay = true;
  audioElement.setAttribute("playsinline", "true");
  audioElement.srcObject = stream;
  applyRemoteAudioOptions(audioElement, options);
  targetMap.set(userId, audioElement);
  void audioElement.play().catch(() => {
    // Ignore autoplay policies; playback will resume after user interaction.
  });
  return audioElement;
}

function applyRemoteAudioOptions(
  audioElement: HTMLAudioElement,
  options?: {
    outputDeviceId?: string | null;
    outputVolumePercent?: number | null;
  },
): void {
  const requestedOutputVolumePercent = Number(options?.outputVolumePercent ?? 100);
  const normalizedOutputVolumePercent = Number.isFinite(requestedOutputVolumePercent)
    ? Math.max(0, Math.min(200, requestedOutputVolumePercent))
    : 100;
  audioElement.volume = Math.max(0, Math.min(1, normalizedOutputVolumePercent / 100));

  const outputDeviceId = String(options?.outputDeviceId ?? "").trim();
  if (!outputDeviceId) {
    return;
  }

  const sinkAwareAudioElement = audioElement as HTMLAudioElement & {
    sinkId?: string;
    setSinkId?: (sinkId: string) => Promise<void>;
  };
  if (typeof sinkAwareAudioElement.setSinkId !== "function") {
    return;
  }
  if (sinkAwareAudioElement.sinkId === outputDeviceId) {
    return;
  }
  void sinkAwareAudioElement.setSinkId(outputDeviceId).catch(() => {
    // Ignore unsupported or blocked output switching.
  });
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
