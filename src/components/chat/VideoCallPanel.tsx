import { useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type MutableRefObject, type SyntheticEvent, type WheelEvent } from "react";
import { flushSync } from "react-dom";
import MaterialSymbolIcon from "../ui/MaterialSymbolIcon";
import { getNameAvatarUrl, isDefaultAvatarUrl } from "../../services/cdn/mediaUrls";
import "../../styles/components/VideoCallPanel.css";

export type VideoCallPanelState = "idle" | "dialing" | "incoming" | "connecting" | "active";
export type VideoCallPanelRole = "caller" | "callee";

interface CallParticipantTile {
  id: string;
  name: string;
  avatarSrc: string;
}

interface VideoCallPanelProps {
  visible: boolean;
  partnerName: string;
  state: VideoCallPanelState;
  role: VideoCallPanelRole | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  localParticipant: CallParticipantTile;
  remoteParticipant: CallParticipantTile;
  showLocalParticipant: boolean;
  showRemoteParticipant: boolean;
  callError?: string | null;
  onAccept?: () => void;
  onDecline?: () => void;
  onEndCall: () => void;
  isMicEnabled: boolean;
  onToggleMute: () => void;
  isOutputAudioEnabled: boolean;
  onOutputAudioEnabledChange?: (enabled: boolean) => void;
  isCameraActive: boolean;
  onToggleCamera: () => void;
  isScreenSharing: boolean;
  remoteScreenSharing?: boolean;
  activeScreenSharerUid?: string | null;
  onToggleScreenShare: () => void;
  isCallPopoutOpen: boolean;
  onToggleCallPopout: () => void;
}

interface StreamVideoProps {
  className: string;
  stream: MediaStream | null;
  muted?: boolean;
  videoRef?: MutableRefObject<HTMLVideoElement | null>;
}

interface AvatarCardPalette {
  surfaceStrong: string;
  deep: string;
  border: string;
  borderStrong: string;
  chip: string;
  glow: string;
  glowSoft: string;
}

function StreamVideo({ className, stream, muted = false, videoRef }: StreamVideoProps) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    element.srcObject = stream;
    if (stream) {
      void element.play().catch(() => {
        // ignore autoplay policy errors
      });
    }

    return () => {
      if (element.srcObject === stream) {
        element.srcObject = null;
      }
    };
  }, [stream]);

  useEffect(() => {
    if (!videoRef) {
      return;
    }

    videoRef.current = ref.current;
    return () => {
      if (videoRef.current === ref.current) {
        videoRef.current = null;
      }
    };
  }, [videoRef]);

  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

function resolveAvatarImageSrc(avatarSrcRaw: string, nameRaw: string): string {
  const fallback = getNameAvatarUrl(String(nameRaw ?? "").trim() || "U");
  const avatarSrc = String(avatarSrcRaw ?? "").trim();
  if (!avatarSrc || isDefaultAvatarUrl(avatarSrc)) {
    return fallback;
  }
  return avatarSrc;
}

function handleAvatarImageError(event: SyntheticEvent<HTMLImageElement>, nameRaw: string): void {
  const target = event.currentTarget;
  target.onerror = null;
  target.src = getNameAvatarUrl(String(nameRaw ?? "").trim() || "U");
}

function hasVideoTrack(stream: MediaStream | null): boolean {
  return Boolean(stream && stream.getVideoTracks().some((track) => track.readyState === "live"));
}

function hasAudioTrack(stream: MediaStream | null): boolean {
  return Boolean(stream && stream.getAudioTracks().some((track) => track.readyState === "live"));
}

function normalizeFps(value: unknown): number | null {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.max(1, Math.round(numeric));
}

function formatStreamQualityLabel(widthRaw: number, heightRaw: number): string {
  const width = Math.max(0, Math.round(widthRaw));
  const height = Math.max(0, Math.round(heightRaw));
  if (height > 0) {
    return `${height}p`;
  }
  if (width > 0) {
    return `${width}px`;
  }
  return "--";
}

function computeStreamRmsLevel(analyser: AnalyserNode, frameBuffer: Uint8Array<ArrayBufferLike>): number {
  analyser.getByteTimeDomainData(frameBuffer as unknown as Uint8Array<ArrayBuffer>);
  let squaredSum = 0;
  for (let index = 0; index < frameBuffer.length; index += 1) {
    const normalized = (frameBuffer[index] - 128) / 128;
    squaredSum += normalized * normalized;
  }
  return Math.sqrt(squaredSum / frameBuffer.length);
}

function hashStringToHue(seedRaw: string): number {
  const seed = String(seedRaw ?? "").trim();
  if (!seed) {
    return 212;
  }
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

function rgbToHue(redRaw: number, greenRaw: number, blueRaw: number): number {
  const red = Math.max(0, Math.min(255, redRaw)) / 255;
  const green = Math.max(0, Math.min(255, greenRaw)) / 255;
  const blue = Math.max(0, Math.min(255, blueRaw)) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  if (delta <= 0.00001) {
    return 212;
  }
  let hue = 0;
  if (max === red) {
    hue = ((green - blue) / delta) % 6;
  } else if (max === green) {
    hue = (blue - red) / delta + 2;
  } else {
    hue = (red - green) / delta + 4;
  }
  hue *= 60;
  if (!Number.isFinite(hue)) {
    return 212;
  }
  return Math.round((hue + 360) % 360);
}

function createAvatarCardPaletteFromHue(hueRaw: number): AvatarCardPalette {
  const hue = Math.round(((Number(hueRaw) % 360) + 360) % 360);
  return {
    surfaceStrong: `hsla(${hue}, 56%, 23%, 0.96)`,
    deep: `hsla(${hue}, 58%, 9%, 0.98)`,
    border: `hsla(${hue}, 70%, 62%, 0.34)`,
    borderStrong: `hsla(${hue}, 78%, 70%, 0.58)`,
    chip: `hsla(${hue}, 46%, 14%, 0.84)`,
    glow: `hsla(${hue}, 76%, 40%, 0.9)`,
    glowSoft: `hsla(${hue}, 72%, 36%, 0.44)`,
  };
}

function createAvatarCardStyle(palette: AvatarCardPalette): CSSProperties {
  const style = {
    "--call-card-surface-strong": palette.surfaceStrong,
    "--call-card-deep": palette.deep,
    "--call-card-border": palette.border,
    "--call-card-border-strong": palette.borderStrong,
    "--call-card-chip": palette.chip,
    "--call-card-glow": palette.glow,
    "--call-card-glow-soft": palette.glowSoft,
  } as Record<string, string>;
  return style as CSSProperties;
}

function toCssUrlValue(urlRaw: string): string | null {
  const url = String(urlRaw ?? "").trim();
  if (!url) {
    return null;
  }
  const safeUrl = url.replace(/["\\\n\r]/g, (character) => {
    if (character === "\n" || character === "\r") {
      return "";
    }
    return `\\${character}`;
  });
  return safeUrl || null;
}

async function extractDominantAvatarHue(avatarSrcRaw: string): Promise<number | null> {
  if (typeof window === "undefined") {
    return null;
  }
  const avatarSrc = String(avatarSrcRaw ?? "").trim();
  if (!avatarSrc) {
    return null;
  }

  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.decoding = "async";

    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 24;
        canvas.height = 24;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          resolve(null);
          return;
        }

        context.clearRect(0, 0, 24, 24);
        context.drawImage(image, 0, 0, 24, 24);
        const imageData = context.getImageData(0, 0, 24, 24).data;
        let weightedRed = 0;
        let weightedGreen = 0;
        let weightedBlue = 0;
        let totalWeight = 0;

        for (let index = 0; index < imageData.length; index += 4) {
          const red = imageData[index];
          const green = imageData[index + 1];
          const blue = imageData[index + 2];
          const alpha = imageData[index + 3] / 255;
          if (alpha <= 0.2) {
            continue;
          }

          const max = Math.max(red, green, blue);
          const min = Math.min(red, green, blue);
          const saturation = max <= 0 ? 0 : (max - min) / max;
          const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
          const weight = alpha * Math.max(0.08, saturation) * (0.25 + luminance);
          weightedRed += red * weight;
          weightedGreen += green * weight;
          weightedBlue += blue * weight;
          totalWeight += weight;
        }

        if (totalWeight <= 0.001) {
          resolve(null);
          return;
        }

        const averageRed = weightedRed / totalWeight;
        const averageGreen = weightedGreen / totalWeight;
        const averageBlue = weightedBlue / totalWeight;
        resolve(rgbToHue(averageRed, averageGreen, averageBlue));
      } catch {
        resolve(null);
      }
    };

    image.onerror = () => {
      resolve(null);
    };

    image.src = avatarSrc;
  });
}

export default function VideoCallPanel({
  visible,
  state,
  role,
  localStream,
  remoteStream,
  localParticipant,
  remoteParticipant,
  showLocalParticipant,
  showRemoteParticipant,
  callError,
  onAccept,
  onDecline,
  onEndCall,
  isMicEnabled,
  onToggleMute,
  isOutputAudioEnabled,
  onOutputAudioEnabledChange,
  isCameraActive,
  onToggleCamera,
  isScreenSharing,
  remoteScreenSharing = false,
  activeScreenSharerUid = null,
  onToggleScreenShare,
  isCallPopoutOpen,
  onToggleCallPopout,
}: VideoCallPanelProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const screenStageRef = useRef<HTMLDivElement | null>(null);
  const shareVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const volumeAnimationTimeoutRef = useRef<number | null>(null);
  const [playbackVolume, setPlaybackVolume] = useState(1);
  const [isPlaybackMuted, setIsPlaybackMuted] = useState(() => !isOutputAudioEnabled);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isScreenStageFullscreen, setIsScreenStageFullscreen] = useState(false);
  const [screenStageContentMetrics, setScreenStageContentMetrics] = useState<{ halfWidth: number; verticalInset: number }>({
    halfWidth: 0,
    verticalInset: 0,
  });
  const [isVolumeAnimating, setIsVolumeAnimating] = useState(false);
  const [isLocalSpeaking, setIsLocalSpeaking] = useState(false);
  const [isRemoteSpeaking, setIsRemoteSpeaking] = useState(false);
  const [selectedScreenSharerUid, setSelectedScreenSharerUid] = useState<string | null>(null);
  const [screenShareLayoutFocus, setScreenShareLayoutFocus] = useState<"grid" | "screen" | "participant">("grid");
  const [focusedParticipantUid, setFocusedParticipantUid] = useState<string | null>(null);
  const [isScreenShareMembersVisible, setIsScreenShareMembersVisible] = useState(false);
  const [participantPaletteById, setParticipantPaletteById] = useState<Record<string, AvatarCardPalette>>({});
  const [activeVideoSize, setActiveVideoSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [activeVideoFps, setActiveVideoFps] = useState<number | null>(null);
  const paletteSourceByIdRef = useRef<Record<string, string>>({});
  const paletteRequestTokenByIdRef = useRef<Record<string, number>>({});
  const remoteVideoEnabled = hasVideoTrack(remoteStream);
  const remoteAudioEnabled = hasAudioTrack(remoteStream);
  const localVideoEnabled = hasVideoTrack(localStream);
  const localScreenSharingActive = isScreenSharing && localVideoEnabled;
  const remoteScreenSharingActive = Boolean(remoteScreenSharing && remoteVideoEnabled);
  const normalizedActiveScreenSharerUid = String(activeScreenSharerUid ?? "").trim();
  const availableScreenSharers = useMemo(() => {
    const next: string[] = [];
    if (localScreenSharingActive) {
      next.push(localParticipant.id);
    }
    if (remoteScreenSharingActive) {
      next.push(remoteParticipant.id);
    }
    return next;
  }, [localParticipant.id, localScreenSharingActive, remoteParticipant.id, remoteScreenSharingActive]);
  const resolvedActiveScreenSharerUid = useMemo(() => {
    if (availableScreenSharers.length === 0) {
      return "";
    }
    const preferredSelected = String(selectedScreenSharerUid ?? "").trim();
    if (preferredSelected && availableScreenSharers.includes(preferredSelected)) {
      return preferredSelected;
    }
    if (normalizedActiveScreenSharerUid && availableScreenSharers.includes(normalizedActiveScreenSharerUid)) {
      return normalizedActiveScreenSharerUid;
    }
    return availableScreenSharers[0];
  }, [availableScreenSharers, normalizedActiveScreenSharerUid, selectedScreenSharerUid]);
  const activeDisplayStream = resolvedActiveScreenSharerUid === localParticipant.id
    ? localStream
    : resolvedActiveScreenSharerUid === remoteParticipant.id
      ? remoteStream
      : null;
  const isTransmissionMode = Boolean(activeDisplayStream && hasVideoTrack(activeDisplayStream));
  const isTransmissionDetached = isTransmissionMode && isCallPopoutOpen;
  const activeDisplayTrack = activeDisplayStream?.getVideoTracks().find((track) => track.readyState === "live") ?? null;
  const presenterParticipant = resolvedActiveScreenSharerUid === localParticipant.id
    ? localParticipant
    : resolvedActiveScreenSharerUid === remoteParticipant.id
      ? remoteParticipant
      : localScreenSharingActive
        ? localParticipant
        : remoteParticipant;
  const visibleParticipants = useMemo(() => {
    const participants: CallParticipantTile[] = [];
    const unique = new Set<string>();
    const addParticipant = (participant: CallParticipantTile): void => {
      const participantId = String(participant.id ?? "").trim();
      if (!participantId || unique.has(participantId)) {
        return;
      }
      unique.add(participantId);
      participants.push(participant);
    };

    const shouldForceShowLocalByState =
      state === "dialing" || state === "connecting" || state === "active";
    const shouldShowLocal =
      shouldForceShowLocalByState ||
      showLocalParticipant ||
      Boolean(localStream) ||
      localScreenSharingActive ||
      resolvedActiveScreenSharerUid === localParticipant.id;
    const shouldShowRemote = showRemoteParticipant || Boolean(remoteStream) || remoteScreenSharingActive || resolvedActiveScreenSharerUid === remoteParticipant.id;

    if (shouldShowLocal) {
      addParticipant(localParticipant);
    }
    if (shouldShowRemote) {
      addParticipant(remoteParticipant);
    }
    if (resolvedActiveScreenSharerUid === localParticipant.id) {
      addParticipant(localParticipant);
    } else if (resolvedActiveScreenSharerUid === remoteParticipant.id) {
      addParticipant(remoteParticipant);
    }
    return participants;
  }, [
    localParticipant,
    localScreenSharingActive,
    localStream,
    remoteParticipant,
    remoteScreenSharingActive,
    remoteStream,
    resolvedActiveScreenSharerUid,
    showLocalParticipant,
    showRemoteParticipant,
    state,
  ]);
  const transmissionDockParticipants = isTransmissionMode ? visibleParticipants : [];
  const focusedParticipant = useMemo(() => {
    const normalizedFocusedUid = String(focusedParticipantUid ?? "").trim();
    if (!normalizedFocusedUid) {
      return null;
    }
    return visibleParticipants.find((participant) => String(participant.id ?? "").trim() === normalizedFocusedUid) ?? null;
  }, [focusedParticipantUid, visibleParticipants]);
  const isParticipantStageFocused = Boolean(
    isTransmissionMode &&
    screenShareLayoutFocus === "participant" &&
    focusedParticipant,
  );
  const isScreenStageFocused = Boolean(
    isTransmissionMode &&
    screenShareLayoutFocus === "screen" &&
    !isTransmissionDetached,
  );
  const isScreenGridMode = Boolean(
    isTransmissionMode &&
    screenShareLayoutFocus === "grid" &&
    !isTransmissionDetached,
  );
  const isAnyScreenShareFocusMode = Boolean(
    isTransmissionMode &&
    !isScreenGridMode &&
    !isTransmissionDetached,
  );
  const transmissionFilmstripParticipants = useMemo(() => {
    if (!isTransmissionMode) {
      return [] as CallParticipantTile[];
    }
    if (!isParticipantStageFocused || !focusedParticipant) {
      return transmissionDockParticipants;
    }
    const focusedUid = String(focusedParticipant.id ?? "").trim();
    return transmissionDockParticipants.filter((participant) => String(participant.id ?? "").trim() !== focusedUid);
  }, [focusedParticipant, isParticipantStageFocused, isTransmissionMode, transmissionDockParticipants]);
  const hasScreenShareMembersStripContent = Boolean(
    transmissionFilmstripParticipants.length > 0 || isParticipantStageFocused,
  );
  const shouldShowScreenShareMembersToggle = Boolean(
    isTransmissionMode && !isScreenGridMode && !isTransmissionDetached && hasScreenShareMembersStripContent,
  );
  const shouldRenderTransmissionFilmstrip = Boolean(
    !isScreenGridMode &&
      !isTransmissionDetached &&
      hasScreenShareMembersStripContent,
  );
  const isTransmissionFilmstripExpanded = shouldRenderTransmissionFilmstrip && isScreenShareMembersVisible;
  const settingsWidth = Number(activeDisplayTrack?.getSettings?.().width ?? 0);
  const settingsHeight = Number(activeDisplayTrack?.getSettings?.().height ?? 0);
  const qualityLabel = formatStreamQualityLabel(
    activeVideoSize.width > 0 ? activeVideoSize.width : settingsWidth,
    activeVideoSize.height > 0 ? activeVideoSize.height : settingsHeight,
  );
  const fpsLabel = activeVideoFps ? `${activeVideoFps}FPS` : "FPS --";
  const shouldMuteTransmissionStage = isPlaybackMuted || resolvedActiveScreenSharerUid === localParticipant.id;
  const normalizedCallError = String(callError ?? "").trim();
  const isReconnectingError = normalizedCallError.toLowerCase().includes("reconectando chamada");
  const volumePercent = Math.round((isPlaybackMuted ? 0 : playbackVolume) * 100);
  const canAdjustVolume = isTransmissionMode || remoteAudioEnabled || remoteVideoEnabled;
  const isAvatarStage = !isTransmissionMode && !remoteVideoEnabled && visibleParticipants.length > 0;
  const isParticipantSpeaking = (participantId: string): boolean => {
    if (participantId === localParticipant.id) {
      return isLocalSpeaking;
    }
    if (participantId === remoteParticipant.id) {
      return isRemoteSpeaking;
    }
    return false;
  };

  const screenStageStyle = useMemo<CSSProperties | undefined>(() => {
    if (!isScreenStageFocused) {
      return undefined;
    }

    return {
      "--video-call-screen-focus-half-width": `${Math.max(0, screenStageContentMetrics.halfWidth)}px`,
      "--video-call-screen-focus-vertical-inset": `${Math.max(0, screenStageContentMetrics.verticalInset)}px`,
    } as CSSProperties;
  }, [isScreenStageFocused, screenStageContentMetrics.halfWidth, screenStageContentMetrics.verticalInset]);

  const returnScreenShareLayoutToGrid = (): void => {
    setScreenShareLayoutFocus("grid");
    setFocusedParticipantUid(null);
    setIsScreenShareMembersVisible(false);
  };

  const focusScreenShareStage = (): void => {
    setScreenShareLayoutFocus("screen");
    setFocusedParticipantUid(null);
    setIsScreenShareMembersVisible(false);
  };

  const focusParticipantStage = (participantId: string): void => {
    setFocusedParticipantUid(participantId);
    setScreenShareLayoutFocus("participant");
    setIsScreenShareMembersVisible(false);
  };

  const resolveParticipantPreviewStream = (participant: CallParticipantTile): MediaStream | null => {
    const participantId = String(participant.id ?? "").trim();
    const isPresenterTile = participantId === presenterParticipant.id;
    if (isPresenterTile && isTransmissionMode) {
      return null;
    }
    if (participantId === localParticipant.id && localVideoEnabled) {
      return localStream;
    }
    if (participantId === remoteParticipant.id && remoteVideoEnabled) {
      return remoteStream;
    }
    return null;
  };

  useEffect(() => {
    let disposed = false;
    const participants = [localParticipant, remoteParticipant];
    for (const participant of participants) {
      const participantId = String(participant.id ?? "").trim();
      if (!participantId) {
        continue;
      }
      const avatarSrc = String(participant.avatarSrc ?? "").trim();
      const seedHue = hashStringToHue(`${participantId}:${participant.name}`);
      const fallbackPalette = createAvatarCardPaletteFromHue(seedHue);

      if (!avatarSrc) {
        setParticipantPaletteById((current) => {
          if (current[participantId]) {
            return current;
          }
          return { ...current, [participantId]: fallbackPalette };
        });
        paletteSourceByIdRef.current[participantId] = "";
        continue;
      }

      if (paletteSourceByIdRef.current[participantId] === avatarSrc) {
        continue;
      }

      paletteSourceByIdRef.current[participantId] = avatarSrc;
      const requestToken = (paletteRequestTokenByIdRef.current[participantId] ?? 0) + 1;
      paletteRequestTokenByIdRef.current[participantId] = requestToken;

      void extractDominantAvatarHue(avatarSrc).then((hue) => {
        if (disposed) {
          return;
        }
        if ((paletteRequestTokenByIdRef.current[participantId] ?? 0) !== requestToken) {
          return;
        }

        const nextPalette = createAvatarCardPaletteFromHue(hue ?? seedHue);
        setParticipantPaletteById((current) => {
          const existing = current[participantId];
          if (
            existing &&
            existing.surfaceStrong === nextPalette.surfaceStrong &&
            existing.deep === nextPalette.deep &&
            existing.border === nextPalette.border &&
            existing.borderStrong === nextPalette.borderStrong &&
            existing.chip === nextPalette.chip &&
            existing.glow === nextPalette.glow &&
            existing.glowSoft === nextPalette.glowSoft
          ) {
            return current;
          }
          return { ...current, [participantId]: nextPalette };
        });
      });
    }

    return () => {
      disposed = true;
    };
  }, [
    localParticipant.avatarSrc,
    localParticipant.id,
    localParticipant.name,
    remoteParticipant.avatarSrc,
    remoteParticipant.id,
    remoteParticipant.name,
  ]);

  const getParticipantCardStyle = (participant: CallParticipantTile): CSSProperties => {
    const participantId = String(participant.id ?? "").trim();
    const fallbackHue = hashStringToHue(`${participantId}:${participant.name}`);
    const palette = participantPaletteById[participantId] ?? createAvatarCardPaletteFromHue(fallbackHue);
    const avatarCssUrl = toCssUrlValue(participant.avatarSrc);
    const baseStyle = createAvatarCardStyle(palette) as Record<string, string>;
    if (avatarCssUrl) {
      baseStyle["--call-card-avatar-image"] = `url("${avatarCssUrl}")`;
    } else {
      baseStyle["--call-card-avatar-image"] = "none";
    }
    return baseStyle as CSSProperties;
  };

  useEffect(() => {
    if (availableScreenSharers.length === 0) {
      setSelectedScreenSharerUid(null);
      return;
    }

    setSelectedScreenSharerUid((current) => {
      const normalizedCurrent = String(current ?? "").trim();
      if (normalizedCurrent && availableScreenSharers.includes(normalizedCurrent)) {
        return normalizedCurrent;
      }
      if (normalizedActiveScreenSharerUid && availableScreenSharers.includes(normalizedActiveScreenSharerUid)) {
        return normalizedActiveScreenSharerUid;
      }
      return availableScreenSharers[0];
    });
  }, [availableScreenSharers, normalizedActiveScreenSharerUid]);

  useEffect(() => {
    if (!isTransmissionMode) {
      setScreenShareLayoutFocus("grid");
      setFocusedParticipantUid(null);
      setIsScreenShareMembersVisible(false);
      return;
    }

    setFocusedParticipantUid((current) => {
      const normalizedCurrent = String(current ?? "").trim();
      if (!normalizedCurrent) {
        return current;
      }
      const exists = visibleParticipants.some((participant) => String(participant.id ?? "").trim() === normalizedCurrent);
      return exists ? current : null;
    });
  }, [isTransmissionMode, visibleParticipants]);

  useEffect(() => {
    if (!isTransmissionMode) {
      return;
    }
    setScreenShareLayoutFocus("grid");
    setFocusedParticipantUid(null);
    setIsScreenShareMembersVisible(false);
  }, [isTransmissionMode, resolvedActiveScreenSharerUid]);

  useEffect(() => {
    if (screenShareLayoutFocus !== "participant") {
      return;
    }
    if (!focusedParticipant) {
      setScreenShareLayoutFocus("grid");
    }
  }, [focusedParticipant, screenShareLayoutFocus]);

  useEffect(() => {
    setIsPlaybackMuted(!isOutputAudioEnabled);
  }, [isOutputAudioEnabled]);

  useEffect(() => {
    const sinkElements = [remoteVideoRef.current, remoteAudioRef.current].filter(
      (element): element is HTMLMediaElement => Boolean(element),
    );
    if (sinkElements.length === 0) {
      return;
    }

    const nextVolume = Math.max(0, Math.min(1, isPlaybackMuted ? 0 : playbackVolume));
    for (const sinkElement of sinkElements) {
      sinkElement.muted = isPlaybackMuted;
      sinkElement.volume = nextVolume;
    }
  }, [isPlaybackMuted, playbackVolume, remoteStream, remoteVideoEnabled]);

  useEffect(() => {
    const remoteAudio = remoteAudioRef.current;
    if (!remoteAudio || remoteVideoEnabled) {
      return;
    }

    remoteAudio.srcObject = remoteStream;
    if (remoteStream) {
      void remoteAudio.play().catch(() => {
        // ignore autoplay policy errors
      });
    }

    return () => {
      if (remoteAudio.srcObject === remoteStream) {
        remoteAudio.srcObject = null;
      }
    };
  }, [remoteStream, remoteVideoEnabled]);

  useEffect(() => {
    const sourceVideo = isTransmissionMode ? shareVideoRef.current : remoteVideoRef.current;
    const sourceTrack = activeDisplayTrack;
    if (!sourceVideo) {
      setActiveVideoSize((current) => {
        const nextWidth = Number(sourceTrack?.getSettings?.().width ?? 0);
        const nextHeight = Number(sourceTrack?.getSettings?.().height ?? 0);
        if (current.width === nextWidth && current.height === nextHeight) {
          return current;
        }
        return { width: nextWidth, height: nextHeight };
      });
      return;
    }

    const syncVideoSize = (): void => {
      const nextWidth = sourceVideo.videoWidth || Number(sourceTrack?.getSettings?.().width ?? 0);
      const nextHeight = sourceVideo.videoHeight || Number(sourceTrack?.getSettings?.().height ?? 0);
      setActiveVideoSize((current) => {
        if (current.width === nextWidth && current.height === nextHeight) {
          return current;
        }
        return { width: nextWidth, height: nextHeight };
      });
    };

    syncVideoSize();
    sourceVideo.addEventListener("loadedmetadata", syncVideoSize);
    sourceVideo.addEventListener("resize", syncVideoSize);
    const intervalId = window.setInterval(syncVideoSize, 1500);
    return () => {
      window.clearInterval(intervalId);
      sourceVideo.removeEventListener("loadedmetadata", syncVideoSize);
      sourceVideo.removeEventListener("resize", syncVideoSize);
    };
  }, [activeDisplayTrack, isTransmissionMode, localStream, remoteStream]);

  useEffect(() => {
    setActiveVideoFps(normalizeFps(activeDisplayTrack?.getSettings?.().frameRate));
  }, [activeDisplayTrack, localStream, remoteStream]);

  useEffect(() => {
    if (!isTransmissionMode || !isScreenStageFocused) {
      setScreenStageContentMetrics((current) => (
        current.halfWidth === 0 && current.verticalInset === 0
          ? current
          : { halfWidth: 0, verticalInset: 0 }
      ));
      return;
    }

    const stage = screenStageRef.current;
    if (!stage) {
      return;
    }

    const sourceWidth = Math.max(0, Number(activeVideoSize.width || settingsWidth || 0));
    const sourceHeight = Math.max(0, Number(activeVideoSize.height || settingsHeight || 0));
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return;
    }

    const syncMetrics = (): void => {
      const rect = stage.getBoundingClientRect();
      const stageWidth = Math.max(0, rect.width);
      const stageHeight = Math.max(0, rect.height);
      if (stageWidth <= 0 || stageHeight <= 0) {
        return;
      }

      const scale = Math.min(stageWidth / sourceWidth, stageHeight / sourceHeight);
      const visibleWidth = sourceWidth * scale;
      const visibleHeight = sourceHeight * scale;
      const halfWidth = Math.max(0, visibleWidth / 2);
      const verticalInset = Math.max(0, (stageHeight - visibleHeight) / 2);

      setScreenStageContentMetrics((current) => {
        if (
          Math.abs(current.halfWidth - halfWidth) < 0.5 &&
          Math.abs(current.verticalInset - verticalInset) < 0.5
        ) {
          return current;
        }
        return { halfWidth, verticalInset };
      });
    };

    syncMetrics();
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          syncMetrics();
        })
      : null;
    resizeObserver?.observe(stage);
    window.addEventListener("resize", syncMetrics);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncMetrics);
    };
  }, [
    activeVideoSize.height,
    activeVideoSize.width,
    isScreenStageFocused,
    isTransmissionMode,
    settingsHeight,
    settingsWidth,
  ]);

  useEffect(() => {
    const isFullscreenTarget = (element: Element | null): boolean =>
      Boolean(
        element &&
          (element === viewportRef.current || element === screenStageRef.current),
      );

    const handleFullscreenChange = (): void => {
      const fullscreenElement = document.fullscreenElement;
      setIsFullscreen(isFullscreenTarget(fullscreenElement));
      setIsScreenStageFullscreen(Boolean(fullscreenElement && fullscreenElement === screenStageRef.current));
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (volumeAnimationTimeoutRef.current != null) {
        window.clearTimeout(volumeAnimationTimeoutRef.current);
        volumeAnimationTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!visible || !localStream) {
      setIsLocalSpeaking(false);
      return;
    }

    const audioTrack = localStream.getAudioTracks().find((track) => track.readyState === "live");
    if (!audioTrack) {
      setIsLocalSpeaking(false);
      return;
    }

    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      setIsLocalSpeaking(false);
      return;
    }

    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.82;
    source.connect(analyser);

    const frameBuffer = new Uint8Array(analyser.fftSize);
    const speakingThreshold = 0.042;
    let rafId = 0;
    let cancelled = false;
    let aboveThresholdFrames = 0;
    let belowThresholdFrames = 0;
    let speaking = false;

    const tick = (): void => {
      if (cancelled) {
        return;
      }

      const rmsLevel = audioTrack.enabled ? computeStreamRmsLevel(analyser, frameBuffer) : 0;
      if (rmsLevel > speakingThreshold) {
        aboveThresholdFrames += 1;
        belowThresholdFrames = 0;
      } else {
        aboveThresholdFrames = 0;
        belowThresholdFrames += 1;
      }

      if (!speaking && aboveThresholdFrames >= 2) {
        speaking = true;
        setIsLocalSpeaking(true);
      } else if (speaking && belowThresholdFrames >= 8) {
        speaking = false;
        setIsLocalSpeaking(false);
      }

      rafId = window.requestAnimationFrame(tick);
    };

    void audioContext.resume().catch(() => {
      // ignore blocked resume
    });
    tick();

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      source.disconnect();
      analyser.disconnect();
      void audioContext.close().catch(() => {
        // ignore close failures
      });
      setIsLocalSpeaking(false);
    };
  }, [localStream, visible]);

  useEffect(() => {
    if (!visible || !remoteStream) {
      setIsRemoteSpeaking(false);
      return;
    }

    const audioTrack = remoteStream.getAudioTracks().find((track) => track.readyState === "live");
    if (!audioTrack) {
      setIsRemoteSpeaking(false);
      return;
    }

    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      setIsRemoteSpeaking(false);
      return;
    }

    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.82;
    source.connect(analyser);

    const frameBuffer = new Uint8Array(analyser.fftSize);
    const speakingThreshold = 0.035;
    let rafId = 0;
    let cancelled = false;
    let aboveThresholdFrames = 0;
    let belowThresholdFrames = 0;
    let speaking = false;

    const tick = (): void => {
      if (cancelled) {
        return;
      }

      const rmsLevel = computeStreamRmsLevel(analyser, frameBuffer);
      if (rmsLevel > speakingThreshold) {
        aboveThresholdFrames += 1;
        belowThresholdFrames = 0;
      } else {
        aboveThresholdFrames = 0;
        belowThresholdFrames += 1;
      }

      if (!speaking && aboveThresholdFrames >= 2) {
        speaking = true;
        setIsRemoteSpeaking(true);
      } else if (speaking && belowThresholdFrames >= 8) {
        speaking = false;
        setIsRemoteSpeaking(false);
      }

      rafId = window.requestAnimationFrame(tick);
    };

    void audioContext.resume().catch(() => {
      // ignore blocked resume
    });
    tick();

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
      source.disconnect();
      analyser.disconnect();
      void audioContext.close().catch(() => {
        // ignore close failures
      });
      setIsRemoteSpeaking(false);
    };
  }, [remoteStream, visible]);

  const triggerVolumeAnimation = (): void => {
    if (volumeAnimationTimeoutRef.current != null) {
      window.clearTimeout(volumeAnimationTimeoutRef.current);
      volumeAnimationTimeoutRef.current = null;
    }
    setIsVolumeAnimating(false);
    window.requestAnimationFrame(() => {
      setIsVolumeAnimating(true);
    });
    volumeAnimationTimeoutRef.current = window.setTimeout(() => {
      setIsVolumeAnimating(false);
      volumeAnimationTimeoutRef.current = null;
    }, 320);
  };

  const handleDecreaseVolume = (): void => {
    setIsPlaybackMuted(false);
    onOutputAudioEnabledChange?.(true);
    setPlaybackVolume((current) => Math.max(0, Math.round((current - 0.1) * 10) / 10));
    triggerVolumeAnimation();
  };

  const handleIncreaseVolume = (): void => {
    setIsPlaybackMuted(false);
    onOutputAudioEnabledChange?.(true);
    setPlaybackVolume((current) => Math.min(1, Math.round((current + 0.1) * 10) / 10));
    triggerVolumeAnimation();
  };

  const handleToggleMutePlayback = (): void => {
    setIsPlaybackMuted((current) => {
      const nextMuted = !current;
      onOutputAudioEnabledChange?.(!nextMuted);
      return nextMuted;
    });
    triggerVolumeAnimation();
  };

  const handleVolumeRangeChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const numeric = Number(event.target.value ?? 0);
    const clampedPercent = Math.max(0, Math.min(100, Math.round(numeric)));
    setPlaybackVolume(clampedPercent / 100);
    const nextMuted = clampedPercent === 0;
    setIsPlaybackMuted(nextMuted);
    onOutputAudioEnabledChange?.(!nextMuted);
    triggerVolumeAnimation();
  };

  const handleVolumeWheel = (event: WheelEvent<HTMLButtonElement>): void => {
    if (!canAdjustVolume) {
      return;
    }
    event.preventDefault();
    if (event.deltaY < 0) {
      handleIncreaseVolume();
      return;
    }
    handleDecreaseVolume();
  };

  const handleToggleFullscreen = (): void => {
    const initialViewportTarget = viewportRef.current;
    const initialStageTarget = screenStageRef.current;
    if (!initialViewportTarget && !initialStageTarget) {
      return;
    }

    const currentFullscreenElement = document.fullscreenElement;
    const isCurrentCallFullscreen =
      currentFullscreenElement === initialViewportTarget || currentFullscreenElement === initialStageTarget;

    if (isCurrentCallFullscreen) {
      void document.exitFullscreen().catch(() => {
        // ignore
      });
      return;
    }

    const requestTargetFullscreen = async (): Promise<void> => {
      const resolveTargets = (): { viewportTarget: HTMLDivElement | null; stageTarget: HTMLDivElement | null } => ({
        viewportTarget: viewportRef.current,
        stageTarget: screenStageRef.current,
      });

      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
      } catch {
        // ignore and still try to request fullscreen on target
      }

      const { viewportTarget, stageTarget } = resolveTargets();
      const primaryTarget = viewportTarget ?? stageTarget;
      const fallbackTarget =
        viewportTarget && stageTarget && stageTarget !== viewportTarget
          ? stageTarget
          : null;

      if (!primaryTarget) {
        return;
      }

      try {
        await primaryTarget.requestFullscreen();
        return;
      } catch {
        if (!fallbackTarget) {
          return;
        }
      }

      try {
        await fallbackTarget.requestFullscreen();
      } catch {
        // ignore
      }
    };

    if (
      isTransmissionMode &&
      !isTransmissionDetached &&
      !isScreenStageFocused &&
      !document.fullscreenElement
    ) {
      const gridViewportTarget = viewportRef.current;
      if (gridViewportTarget) {
        void gridViewportTarget.requestFullscreen()
          .then(() => {
            focusScreenShareStage();
          })
          .catch(() => {
            flushSync(() => {
              focusScreenShareStage();
            });
            void requestTargetFullscreen();
          });
        return;
      }

      flushSync(() => {
        focusScreenShareStage();
      });
      void requestTargetFullscreen();
      return;
    }

    void requestTargetFullscreen();
  };

  if (!visible || state === "idle") {
    return null;
  }

  const renderPrimaryCallActions = (): JSX.Element => {
    if (state === "incoming" && role === "callee") {
      return (
        <div className="video-call-actions">
          <button
            className="video-call-btn video-call-btn--accept"
            type="button"
            onClick={onAccept}
            aria-label="Aceitar chamada"
            title="Aceitar chamada"
          >
            <MaterialSymbolIcon name="call" size={18} />
          </button>
          <button
            className="video-call-btn video-call-btn--hangup"
            type="button"
            onClick={onDecline}
            aria-label="Recusar chamada"
            title="Recusar chamada"
          >
            <MaterialSymbolIcon name="call_end" size={18} />
          </button>
        </div>
      );
    }

    return (
      <div className="video-call-controls video-call-controls--card">
        <button
          type="button"
          className={`video-call-control${isMicEnabled ? "" : " is-off"}`}
          onClick={onToggleMute}
          aria-label={isMicEnabled ? "Mutar microfone" : "Desmutar microfone"}
          title={isMicEnabled ? "Mutar microfone" : "Desmutar microfone"}
        >
          <MaterialSymbolIcon name={isMicEnabled ? "mic" : "mic_off"} size={18} />
        </button>
        <button
          type="button"
          className={`video-call-control${isCameraActive ? "" : " is-off"}`}
          onClick={onToggleCamera}
          aria-label={isCameraActive ? "Desligar camera" : "Ligar camera"}
          title={isCameraActive ? "Desligar camera" : "Ligar camera"}
        >
          <MaterialSymbolIcon name={isCameraActive ? "videocam" : "videocam_off"} size={18} />
        </button>
        <button
          type="button"
          className={`video-call-control${isScreenSharing ? " is-active" : ""}`}
          onClick={onToggleScreenShare}
          aria-label={isScreenSharing ? "Parar compartilhamento de tela" : "Compartilhar tela"}
          title={isScreenSharing ? "Parar compartilhamento de tela" : "Compartilhar tela"}
        >
          <MaterialSymbolIcon name={isScreenSharing ? "stop_screen_share" : "screen_share"} size={18} />
        </button>
        <button
          type="button"
          className="video-call-control is-hangup"
          onClick={onEndCall}
          aria-label="Desconectar"
          title="Desconectar"
        >
          <MaterialSymbolIcon name="call_end" size={18} />
        </button>
      </div>
    );
  };

  const renderTransmissionControls = (className = "", style?: CSSProperties): JSX.Element => (
    <div
      className={`video-call-share-controls${className ? ` ${className}` : ""}`}
      role="toolbar"
      aria-label="Controles da transmissao"
      style={style}
    >
      <div className={`video-call-volume-control${isVolumeAnimating ? " is-volume-anim" : ""}`}>
        <button
          type="button"
          className={`video-call-share-btn video-call-share-btn--volume-toggle${isPlaybackMuted ? " is-active" : ""}`}
          onClick={handleToggleMutePlayback}
          onWheel={handleVolumeWheel}
          aria-label={isPlaybackMuted ? "Ativar som da transmissao" : "Silenciar som da transmissao"}
          title={`${isPlaybackMuted ? "Ativar som" : "Silenciar som"} (${volumePercent}%)`}
          disabled={!canAdjustVolume}
        >
          <MaterialSymbolIcon name={isPlaybackMuted ? "volume_off" : "volume_up"} size={16} />
        </button>
        <div className="video-call-volume-popover" role="group" aria-label="Ajuste de volume">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            className="video-call-volume-slider"
            value={volumePercent}
            onChange={handleVolumeRangeChange}
            aria-label="Volume da transmissao"
            disabled={!canAdjustVolume}
          />
        </div>
      </div>
      <button
        type="button"
        className={`video-call-share-btn${isFullscreen ? " is-active" : ""}`}
        onClick={handleToggleFullscreen}
        aria-label={isFullscreen ? "Sair da tela cheia" : "Colocar transmissao em tela cheia"}
        title={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
      >
        <MaterialSymbolIcon name={isFullscreen ? "fullscreen_exit" : "fullscreen"} size={18} />
      </button>
      <button
        type="button"
        className={`video-call-share-btn${isCallPopoutOpen ? " is-active" : ""}`}
        onClick={onToggleCallPopout}
        aria-label={isCallPopoutOpen ? "Voltar transmissao para chamada" : "Abrir transmissao em outra janela"}
        title={isCallPopoutOpen ? "Voltar transmissao para chamada" : "Abrir transmissao em outra janela"}
      >
        <MaterialSymbolIcon name={isCallPopoutOpen ? "keyboard_return" : "open_in_new"} size={18} />
      </button>
    </div>
  );

  const renderTransmissionPreviewControls = (): JSX.Element => (
    <div className="video-call-screen-tile__controls" role="toolbar" aria-label="Controles da transmissao">
      <div className={`video-call-volume-control${isVolumeAnimating ? " is-volume-anim" : ""}`}>
        <button
          type="button"
          className={`video-call-share-btn video-call-share-btn--volume-toggle${isPlaybackMuted ? " is-active" : ""}`}
          onClick={handleToggleMutePlayback}
          onWheel={handleVolumeWheel}
          aria-label={isPlaybackMuted ? "Ativar som da transmissao" : "Silenciar som da transmissao"}
          title={`${isPlaybackMuted ? "Ativar som" : "Silenciar som"} (${volumePercent}%)`}
          disabled={!canAdjustVolume}
        >
          <MaterialSymbolIcon name={isPlaybackMuted ? "volume_off" : "volume_up"} size={16} />
        </button>
        <div className="video-call-volume-popover" role="group" aria-label="Ajuste de volume">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            className="video-call-volume-slider"
            value={volumePercent}
            onChange={handleVolumeRangeChange}
            aria-label="Volume da transmissao"
            disabled={!canAdjustVolume}
          />
        </div>
      </div>
      <button
        type="button"
        className={`video-call-share-btn${isFullscreen ? " is-active" : ""}`}
        onClick={handleToggleFullscreen}
        aria-label={isFullscreen ? "Sair da tela cheia" : "Colocar transmissao em tela cheia"}
        title={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
      >
        <MaterialSymbolIcon name={isFullscreen ? "fullscreen_exit" : "fullscreen"} size={18} />
      </button>
      <button
        type="button"
        className={`video-call-share-btn${isCallPopoutOpen ? " is-active" : ""}`}
        onClick={onToggleCallPopout}
        aria-label={isCallPopoutOpen ? "Voltar transmissao para chamada" : "Abrir transmissao em outra janela"}
        title={isCallPopoutOpen ? "Voltar transmissao para chamada" : "Abrir transmissao em outra janela"}
      >
        <MaterialSymbolIcon name={isCallPopoutOpen ? "keyboard_return" : "open_in_new"} size={18} />
      </button>
    </div>
  );

  return (
    <div className={`video-call-wrapper${isTransmissionMode ? " is-screen-share-mode" : ""}`} aria-live="polite">
      <div className={`video-call-card${isTransmissionMode ? " is-screen-share-layout" : ""}`}>
        <div
          ref={viewportRef}
          className={`video-call-viewport${isTransmissionMode ? " is-screen-share-layout" : ""}`}
        >
          {remoteVideoEnabled && !isTransmissionMode ? (
            <StreamVideo className="remote-video" stream={remoteStream} videoRef={remoteVideoRef} />
          ) : null}
          {!remoteVideoEnabled && remoteAudioEnabled ? <audio ref={remoteAudioRef} autoPlay playsInline className="video-call-remote-audio" /> : null}

          <div className={`video-call-overlay${isFullscreen ? " is-fullscreen" : ""}${isAvatarStage ? " is-avatar-stage" : ""}${isTransmissionMode ? " is-screen-share" : ""}${isTransmissionMode && isScreenStageFocused ? " is-screen-share-focus-stage" : ""}${isTransmissionMode && isScreenShareMembersVisible ? " is-screen-share-members-visible" : ""}`}>
            {isTransmissionMode ? (
              <div className="video-call-screen-layout">
                {isScreenGridMode ? (
                  <div className="video-call-screen-grid" aria-label="Grade da chamada com transmissao">
                    <div
                      className="video-call-screen-grid__tile video-call-screen-grid__tile--share"
                      role="button"
                      tabIndex={0}
                      onClick={focusScreenShareStage}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          focusScreenShareStage();
                        }
                      }}
                      aria-label={`Tela compartilhada de ${presenterParticipant.name}`}
                      title={`Tela compartilhada de ${presenterParticipant.name}`}
                    >
                      <StreamVideo
                        className="video-call-screen-grid__video"
                        stream={activeDisplayStream}
                        muted={shouldMuteTransmissionStage}
                      />
                      <div className="video-call-screen-stage__label">
                        <span>{presenterParticipant.name}</span>
                      </div>
                      <div className="video-call-screen-stage__quality">{qualityLabel} {fpsLabel}</div>
                      <div
                        className="video-call-screen-stage__controls"
                        onClick={(event) => event.stopPropagation()}
                        onMouseDown={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        {renderTransmissionControls("video-call-share-controls--in-stage")}
                      </div>
                    </div>

                    {transmissionDockParticipants.map((participant) => {
                      const participantId = String(participant.id ?? "").trim();
                      const isPresenterTile = participantId === presenterParticipant.id;
                      const isLocalTile = participantId === localParticipant.id;
                      const isParticipantScreenSharing = participantId === localParticipant.id
                        ? localScreenSharingActive
                        : participantId === remoteParticipant.id
                          ? remoteScreenSharingActive
                          : false;
                      const previewStream = resolveParticipantPreviewStream(participant);
                      const hasPreview = Boolean(previewStream && hasVideoTrack(previewStream));
                      return (
                        <button
                          key={`grid-${participant.id}`}
                          type="button"
                          className={`video-call-screen-tile video-call-screen-tile--grid${isPresenterTile ? " is-presenter" : ""}${isParticipantSpeaking(participant.id) ? " is-speaking" : ""}`}
                          style={getParticipantCardStyle(participant)}
                          onClick={() => {
                            focusParticipantStage(participantId);
                            if (isParticipantScreenSharing) {
                              setSelectedScreenSharerUid(participantId);
                            }
                          }}
                          aria-label={`Participante ${participant.name}`}
                          title={participant.name}
                        >
                          {isParticipantScreenSharing ? (
                            <span className="video-call-screen-tile__badge">
                              <MaterialSymbolIcon className="video-call-source-title-icon" name="screen_share" size={12} />
                              <span>Compartilhando</span>
                            </span>
                          ) : null}
                          {hasPreview ? (
                            <StreamVideo className="video-call-screen-tile__video" stream={previewStream} muted={isLocalTile} />
                          ) : (
                            <img
                              className="video-call-screen-tile__avatar"
                              src={resolveAvatarImageSrc(participant.avatarSrc, participant.name)}
                              alt={`Avatar de ${participant.name}`}
                              loading="lazy"
                              onError={(event) => {
                                handleAvatarImageError(event, participant.name);
                              }}
                            />
                          )}
                          <span className="video-call-screen-tile__meta">
                            <span className="video-call-screen-tile__name">{participant.name}</span>
                            <span className="video-call-screen-tile__icons">
                              {isLocalTile && !isMicEnabled ? <MaterialSymbolIcon name="mic_off" size={13} /> : null}
                              {isParticipantScreenSharing ? <MaterialSymbolIcon name="desktop_windows" size={13} /> : null}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                <div
                  ref={screenStageRef}
                  className={`video-call-screen-stage${isAnyScreenShareFocusMode ? " is-focus-size" : ""}${isScreenStageFocused ? " is-screen-focus" : ""}`}
                  style={screenStageStyle}
                  role={!isTransmissionDetached ? "button" : undefined}
                  tabIndex={!isTransmissionDetached ? 0 : -1}
                  onClick={() => {
                    if (isTransmissionDetached) {
                      return;
                    }
                    returnScreenShareLayoutToGrid();
                  }}
                  onKeyDown={(event) => {
                    if (isTransmissionDetached) {
                      return;
                    }
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      returnScreenShareLayoutToGrid();
                    }
                  }}
                  aria-label={!isTransmissionDetached ? "Voltar para grade da chamada" : undefined}
                >
                  {isTransmissionDetached ? (
                    <div className="video-call-transmission-detached" role="status" aria-live="polite">
                      <p>Transmissao aberta em outra janela.</p>
                      <button
                        type="button"
                        className="video-call-transmission-detached__return"
                        onClick={() => {
                          onToggleCallPopout();
                        }}
                      >
                        Voltar transmissao para chamada
                      </button>
                    </div>
                  ) : (
                    isParticipantStageFocused && focusedParticipant ? (
                      <>
                        <div
                          className={`video-call-screen-stage__member${isParticipantSpeaking(focusedParticipant.id) ? " is-speaking" : ""}`}
                          style={getParticipantCardStyle(focusedParticipant)}
                        >
                          <div className="video-call-screen-stage__member-glass" aria-hidden="true" />
                          <img
                            className="video-call-screen-stage__member-avatar"
                            src={resolveAvatarImageSrc(focusedParticipant.avatarSrc, focusedParticipant.name)}
                            alt={`Avatar de ${focusedParticipant.name}`}
                            loading="lazy"
                            onError={(event) => {
                              handleAvatarImageError(event, focusedParticipant.name);
                            }}
                          />
                          <div className="video-call-screen-stage__member-name">
                            <span>{focusedParticipant.name}</span>
                            {String(focusedParticipant.id ?? "").trim() === presenterParticipant.id ? (
                              <span className="video-call-screen-stage__member-presenting">
                                <MaterialSymbolIcon className="video-call-source-title-icon" name="screen_share" size={12} />
                                Compartilhando
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="video-call-screen-stage__quality">{qualityLabel} {fpsLabel}</div>
                        <div
                          className="video-call-screen-stage__controls"
                          onClick={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          {renderTransmissionControls("video-call-share-controls--in-stage")}
                        </div>
                      </>
                    ) : (
                      <>
                        <StreamVideo
                          className="video-call-screen-stage__video"
                          stream={activeDisplayStream}
                          muted={shouldMuteTransmissionStage}
                          videoRef={shareVideoRef}
                        />
                        <div className="video-call-screen-stage__label">
                          <span>{presenterParticipant.name}</span>
                        </div>
                        <div className="video-call-screen-stage__quality">{qualityLabel} {fpsLabel}</div>
                        <div
                          className="video-call-screen-stage__controls"
                          onClick={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          {renderTransmissionControls("video-call-share-controls--in-stage")}
                        </div>
                        {shouldShowScreenShareMembersToggle && isScreenStageFocused ? (
                          <div
                            className="video-call-screen-stage__members-toggle"
                            onClick={(event) => event.stopPropagation()}
                            onMouseDown={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="video-call-participants-toggle video-call-participants-toggle--screen-share video-call-participants-toggle--in-stage"
                              onClick={() => {
                                setIsScreenShareMembersVisible((current) => !current);
                              }}
                              aria-label={isScreenShareMembersVisible ? "Ocultar membros" : "Mostrar membros"}
                              title={isScreenShareMembersVisible ? "Ocultar membros" : "Mostrar membros"}
                              data-tooltip={isScreenShareMembersVisible ? "Ocultar membros" : "Mostrar membros"}
                            >
                              <MaterialSymbolIcon name={isScreenShareMembersVisible ? "expand_more" : "expand_less"} size={14} />
                              <MaterialSymbolIcon name="groups" size={16} />
                            </button>
                          </div>
                        ) : null}
                        {isFullscreen && isScreenStageFocused ? (
                          <div
                            className="video-call-screen-stage__call-controls"
                            onClick={(event) => event.stopPropagation()}
                            onMouseDown={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            {renderPrimaryCallActions()}
                          </div>
                        ) : null}
                      </>
                    )
                  )}
                </div>
                )}

                {shouldRenderTransmissionFilmstrip ? (
                  <div
                    className={`video-call-screen-filmstrip${isTransmissionFilmstripExpanded ? " is-visible" : " is-collapsed"}`}
                    aria-label="Participantes da chamada"
                    aria-hidden={!isTransmissionFilmstripExpanded}
                  >
                    {isParticipantStageFocused ? (
                      <div
                        className="video-call-screen-tile video-call-screen-tile--share-preview"
                        role="button"
                        tabIndex={0}
                        onClick={focusScreenShareStage}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            focusScreenShareStage();
                          }
                        }}
                        aria-label={`Tela compartilhada de ${presenterParticipant.name}`}
                        title={`Tela compartilhada de ${presenterParticipant.name}`}
                      >
                        <StreamVideo
                          className="video-call-screen-tile__video"
                          stream={activeDisplayStream}
                          muted={shouldMuteTransmissionStage}
                        />
                        <span className="video-call-screen-tile__badge">
                          <MaterialSymbolIcon className="video-call-source-title-icon" name="screen_share" size={12} />
                          <span>Tela</span>
                        </span>
                        <span className="video-call-screen-tile__quality-pill">{qualityLabel} {fpsLabel}</span>
                        <span className="video-call-screen-tile__meta">
                          <span className="video-call-screen-tile__name">{presenterParticipant.name}</span>
                          <span className="video-call-screen-tile__icons">
                            <MaterialSymbolIcon name="desktop_windows" size={13} />
                          </span>
                        </span>
                        <div
                          onClick={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          {renderTransmissionPreviewControls()}
                        </div>
                      </div>
                    ) : null}

                    {transmissionFilmstripParticipants.map((participant) => {
                      const participantId = String(participant.id ?? "").trim();
                      const isPresenterTile = participantId === presenterParticipant.id;
                      const isLocalTile = participantId === localParticipant.id;
                      const isParticipantScreenSharing = participantId === localParticipant.id
                        ? localScreenSharingActive
                        : participantId === remoteParticipant.id
                          ? remoteScreenSharingActive
                          : false;
                      const previewStream = resolveParticipantPreviewStream(participant);
                      const hasPreview = Boolean(previewStream && hasVideoTrack(previewStream));
                      return (
                        <button
                          key={participant.id}
                          type="button"
                          className={`video-call-screen-tile${isPresenterTile ? " is-presenter" : ""}${isParticipantSpeaking(participant.id) ? " is-speaking" : ""}${focusedParticipant && participantId === focusedParticipant.id && isParticipantStageFocused ? " is-stage-focused" : ""}`}
                          style={getParticipantCardStyle(participant)}
                          onClick={() => {
                            focusParticipantStage(participantId);
                            if (isParticipantScreenSharing) {
                              setSelectedScreenSharerUid(participantId);
                            }
                          }}
                          aria-label={`Participante ${participant.name}`}
                          title={participant.name}
                        >
                          {isParticipantScreenSharing ? (
                            <span className="video-call-screen-tile__badge">
                              <MaterialSymbolIcon className="video-call-source-title-icon" name="screen_share" size={12} />
                              <span>Compartilhando</span>
                            </span>
                          ) : null}
                          {hasPreview ? (
                            <StreamVideo className="video-call-screen-tile__video" stream={previewStream} muted={isLocalTile} />
                          ) : (
                            <img
                              className="video-call-screen-tile__avatar"
                              src={resolveAvatarImageSrc(participant.avatarSrc, participant.name)}
                              alt={`Avatar de ${participant.name}`}
                              loading="lazy"
                              onError={(event) => {
                                handleAvatarImageError(event, participant.name);
                              }}
                            />
                          )}
                          <span className="video-call-screen-tile__meta">
                            <span className="video-call-screen-tile__name">{participant.name}</span>
                            <span className="video-call-screen-tile__icons">
                              {isLocalTile && !isMicEnabled ? <MaterialSymbolIcon name="mic_off" size={13} /> : null}
                              {isParticipantScreenSharing ? <MaterialSymbolIcon name="desktop_windows" size={13} /> : null}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

            {isAvatarStage ? (
              <div className={`video-call-participants${visibleParticipants.length === 1 ? " video-call-participants--single" : ""}`}>
                {visibleParticipants.map((participant) => (
                  <div
                    key={participant.id}
                    className={`video-call-participant${isParticipantSpeaking(participant.id) ? " is-speaking" : ""}`}
                    style={getParticipantCardStyle(participant)}
                  >
                    <img
                      src={resolveAvatarImageSrc(participant.avatarSrc, participant.name)}
                      alt={`Avatar de ${participant.name}`}
                      onError={(event) => {
                        handleAvatarImageError(event, participant.name);
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {!isTransmissionMode ? (
              <div className="video-call-footer">
                {renderPrimaryCallActions()}
                {callError && !isReconnectingError ? <div className="video-call-error">{callError}</div> : null}
              </div>
            ) : (
              <div className="video-call-footer video-call-footer--screen-share">
                <div className="video-call-transmission-actions">
                  {shouldShowScreenShareMembersToggle && !isScreenStageFocused ? (
                    <button
                      type="button"
                      className="video-call-participants-toggle video-call-participants-toggle--screen-share"
                      onClick={() => {
                        setIsScreenShareMembersVisible((current) => !current);
                      }}
                      aria-label={isScreenShareMembersVisible ? "Ocultar membros" : "Mostrar membros"}
                      title={isScreenShareMembersVisible ? "Ocultar membros" : "Mostrar membros"}
                      data-tooltip={isScreenShareMembersVisible ? "Ocultar membros" : "Mostrar membros"}
                    >
                      <MaterialSymbolIcon name={isScreenShareMembersVisible ? "expand_more" : "expand_less"} size={14} />
                      <MaterialSymbolIcon name="groups" size={16} />
                    </button>
                  ) : null}
                  {renderPrimaryCallActions()}
                  {callError && !isReconnectingError ? <div className="video-call-error">{callError}</div> : null}
                </div>
              </div>
            )}
          </div>

          {localVideoEnabled && !isFullscreen && !isTransmissionMode ? (
            <StreamVideo className="local-video" stream={localStream} muted />
          ) : null}
        </div>
      </div>
    </div>
  );
}
