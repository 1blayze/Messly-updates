import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseWasmSimdUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

type VoiceNoiseSuppressionMode = "off" | "webrtc" | "rnnoise";

export interface MicrophoneCaptureOptions {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  noiseSuppressionMode?: VoiceNoiseSuppressionMode;
  autoGainControl?: boolean;
  channelCount?: number;
  sampleRate?: number;
  sampleSize?: number;
  latency?: number;
  deviceId?: string | null;
  inputVolumePercent?: number | null;
}

export interface VoiceInputQualityReport {
  level: number;
  noiseLevel: number;
  clipping: boolean;
  lowVolume: boolean;
  excessiveNoise: boolean;
  distortion: boolean;
  warningMessage: string | null;
}

export interface VoiceAudioPipelineOptions {
  noiseSuppressionMode?: VoiceNoiseSuppressionMode;
  onQuality?: (report: VoiceInputQualityReport) => void;
}

export interface VoiceAudioPipelineSession {
  stream: MediaStream;
  stop: () => void;
}

const DEFAULT_MIC_OPTIONS: Required<MicrophoneCaptureOptions> = {
  echoCancellation: true,
  noiseSuppression: true,
  noiseSuppressionMode: "webrtc",
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48_000,
  sampleSize: 16,
  latency: 0,
  deviceId: "",
  inputVolumePercent: 100,
};

const HIGH_PASS_CUTOFF_HZ = 80;
const VOICE_LOW_CUT_HZ = 200;
const VOICE_PRESENCE_HZ = 3_000;
const NOISE_GATE_OPEN_GAIN = 1;
const NOISE_GATE_CLOSED_GAIN = 0.42;
const QUALITY_EMIT_INTERVAL_MS = 120;
const RNNOISE_MAX_CHANNELS = 1;

let rnnoiseWasmBinaryPromise: Promise<ArrayBuffer> | null = null;
const rnnoiseWorkletContextIds = new WeakSet<AudioContext>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveAudioContextCtor():
  | (new (contextOptions?: AudioContextOptions) => AudioContext)
  | null {
  const audioWindow = window as Window & {
    AudioContext?: new (contextOptions?: AudioContextOptions) => AudioContext;
    webkitAudioContext?: new (contextOptions?: AudioContextOptions) => AudioContext;
  };
  return audioWindow.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function toNormalizedLevel(db: number): number {
  return clamp((db + 72) / 60, 0, 1);
}

function resolveNoiseSuppressionMode(modeRaw: unknown, fallback: VoiceNoiseSuppressionMode = "webrtc"): VoiceNoiseSuppressionMode {
  const normalized = String(modeRaw ?? "").trim().toLowerCase();
  if (normalized === "off" || normalized === "webrtc" || normalized === "rnnoise") {
    return normalized;
  }
  return fallback;
}

function logVoiceCaptureStart(
  mode: VoiceNoiseSuppressionMode,
  options: Pick<Required<MicrophoneCaptureOptions>, "echoCancellation" | "autoGainControl" | "sampleRate" | "channelCount">,
): void {
  console.info("[voice:audio] VOICE_CAPTURE_STARTED", {
    noiseSuppressionMode: mode,
    echoCancellation: options.echoCancellation,
    autoGainControl: options.autoGainControl,
    sampleRate: options.sampleRate,
    channelCount: options.channelCount,
  });
  if (mode === "off") {
    console.info("[voice:audio] VOICE_NOISE_SUPPRESSION_OFF");
  } else if (mode === "webrtc") {
    console.info("[voice:audio] VOICE_NOISE_SUPPRESSION_WEBRTC");
  } else {
    console.info("[voice:audio] VOICE_NOISE_SUPPRESSION_RNNOISE");
  }

  if (options.echoCancellation) {
    console.info("[voice:audio] VOICE_ECHO_CANCELLATION_ENABLED");
  } else {
    console.info("[voice:audio] VOICE_ECHO_CANCELLATION_DISABLED");
  }
}

async function ensureRnnoiseWasmBinary(): Promise<ArrayBuffer> {
  if (!rnnoiseWasmBinaryPromise) {
    rnnoiseWasmBinaryPromise = loadRnnoise({
      url: rnnoiseWasmUrl,
      simdUrl: rnnoiseWasmSimdUrl,
    });
  }
  return rnnoiseWasmBinaryPromise;
}

async function ensureRnnoiseWorkletModule(context: AudioContext): Promise<void> {
  if (rnnoiseWorkletContextIds.has(context)) {
    return;
  }
  await context.audioWorklet.addModule(rnnoiseWorkletUrl);
  rnnoiseWorkletContextIds.add(context);
}

async function tryEnableNativeNoiseSuppression(stream: MediaStream): Promise<void> {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    return;
  }
  await Promise.all(
    audioTracks.map(async (track) => {
      try {
        await track.applyConstraints({
          noiseSuppression: true,
        });
      } catch {
        // Ignore unsupported runtime constraints.
      }
    }),
  );
}

export async function captureMicrophoneStream(
  options: MicrophoneCaptureOptions = DEFAULT_MIC_OPTIONS,
): Promise<MediaStream> {
  const noiseSuppressionMode = resolveNoiseSuppressionMode(
    options.noiseSuppressionMode,
    typeof options.noiseSuppression === "boolean"
      ? (options.noiseSuppression ? "webrtc" : "off")
      : "webrtc",
  );
  const normalizedDeviceId = String(options.deviceId ?? "").trim();
  const requestedInputVolumePercent = Number(options.inputVolumePercent ?? 100);
  const normalizedInputVolume = Number.isFinite(requestedInputVolumePercent)
    ? Math.max(0, Math.min(100, requestedInputVolumePercent)) / 100
    : 1;
  const normalizedEchoCancellation = options.echoCancellation ?? DEFAULT_MIC_OPTIONS.echoCancellation;
  const normalizedAutoGain = options.autoGainControl ?? DEFAULT_MIC_OPTIONS.autoGainControl;
  const normalizedSampleRate = options.sampleRate ?? DEFAULT_MIC_OPTIONS.sampleRate;
  const normalizedChannelCount = options.channelCount ?? DEFAULT_MIC_OPTIONS.channelCount;

  logVoiceCaptureStart(noiseSuppressionMode, {
    echoCancellation: normalizedEchoCancellation,
    autoGainControl: normalizedAutoGain,
    sampleRate: normalizedSampleRate,
    channelCount: normalizedChannelCount,
  });

  const baseConstraints: MediaTrackConstraints = {
    echoCancellation: normalizedEchoCancellation,
    noiseSuppression: noiseSuppressionMode === "webrtc",
    autoGainControl: normalizedAutoGain,
    channelCount: normalizedChannelCount,
  };
  (baseConstraints as MediaTrackConstraints & { volume?: number }).volume = normalizedInputVolume;

  const highFidelityConstraints: MediaTrackConstraints = {
    ...baseConstraints,
    sampleRate: normalizedSampleRate,
    sampleSize: options.sampleSize ?? DEFAULT_MIC_OPTIONS.sampleSize,
  };
  (highFidelityConstraints as MediaTrackConstraints & { latency?: number }).latency =
    options.latency ?? DEFAULT_MIC_OPTIONS.latency;

  const constraintsQueue: MediaTrackConstraints[] = [];
  if (normalizedDeviceId) {
    constraintsQueue.push({
      ...highFidelityConstraints,
      deviceId: {
        exact: normalizedDeviceId,
      },
    });
  }
  constraintsQueue.push(highFidelityConstraints);
  if (normalizedDeviceId) {
    constraintsQueue.push({
      ...baseConstraints,
      deviceId: {
        exact: normalizedDeviceId,
      },
    });
  }
  constraintsQueue.push(baseConstraints);

  let lastError: unknown = null;
  for (const audioConstraints of constraintsQueue) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: audioConstraints,
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Falha ao capturar microfone.");
}

export async function createVoiceAudioPipeline(
  inputStream: MediaStream,
  options: VoiceAudioPipelineOptions = {},
): Promise<VoiceAudioPipelineSession> {
  const requestedNoiseSuppressionMode = resolveNoiseSuppressionMode(options.noiseSuppressionMode, "webrtc");
  let effectiveNoiseSuppressionMode = requestedNoiseSuppressionMode;
  const AudioContextCtor = resolveAudioContextCtor();
  if (!AudioContextCtor) {
    if (requestedNoiseSuppressionMode === "rnnoise") {
      console.warn("[voice:audio] RNNoise indisponivel neste navegador. Usando fallback WebRTC.");
      await tryEnableNativeNoiseSuppression(inputStream);
      effectiveNoiseSuppressionMode = "webrtc";
      console.info("[voice:audio] VOICE_NOISE_SUPPRESSION_WEBRTC");
    }
    return {
      stream: inputStream,
      stop: () => undefined,
    };
  }

  let context: AudioContext;
  try {
    context = new AudioContextCtor({
      sampleRate: 48_000,
      latencyHint: "interactive",
    });
  } catch {
    context = new AudioContextCtor();
  }

  const source = context.createMediaStreamSource(inputStream);
  let processingSource: AudioNode = source;
  let rnnoiseNode: RnnoiseWorkletNode | null = null;
  if (requestedNoiseSuppressionMode === "rnnoise") {
    try {
      const wasmBinary = await ensureRnnoiseWasmBinary();
      await ensureRnnoiseWorkletModule(context);
      rnnoiseNode = new RnnoiseWorkletNode(context, {
        maxChannels: RNNOISE_MAX_CHANNELS,
        wasmBinary,
      });
      source.connect(rnnoiseNode);
      processingSource = rnnoiseNode;
    } catch (error) {
      effectiveNoiseSuppressionMode = "webrtc";
      console.warn("[voice:audio] RNNoise nao carregou. Usando fallback WebRTC.", error);
      await tryEnableNativeNoiseSuppression(inputStream);
      console.info("[voice:audio] VOICE_NOISE_SUPPRESSION_WEBRTC");
    }
  }

  let highPass: BiquadFilterNode | null = null;
  let adaptiveNoiseGate: GainNode | null = null;
  let lowCut: BiquadFilterNode | null = null;
  let presenceBoost: BiquadFilterNode | null = null;
  let compressor: DynamicsCompressorNode | null = null;
  let limiter: DynamicsCompressorNode | null = null;
  if (effectiveNoiseSuppressionMode !== "off") {
    highPass = context.createBiquadFilter();
    highPass.type = "highpass";
    highPass.frequency.value = HIGH_PASS_CUTOFF_HZ;
    highPass.Q.value = 0.707;

    adaptiveNoiseGate = context.createGain();
    adaptiveNoiseGate.gain.value = NOISE_GATE_OPEN_GAIN;

    lowCut = context.createBiquadFilter();
    lowCut.type = "peaking";
    lowCut.frequency.value = VOICE_LOW_CUT_HZ;
    lowCut.Q.value = 1.1;
    lowCut.gain.value = -3;

    presenceBoost = context.createBiquadFilter();
    presenceBoost.type = "peaking";
    presenceBoost.frequency.value = VOICE_PRESENCE_HZ;
    presenceBoost.Q.value = 1.2;
    presenceBoost.gain.value = 3;

    compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
  }

  const destination = context.createMediaStreamDestination();
  const analyser = context.createAnalyser();
  analyser.fftSize = 2_048;
  analyser.smoothingTimeConstant = 0.12;

  if (effectiveNoiseSuppressionMode === "off") {
    source.connect(destination);
  } else if (highPass && adaptiveNoiseGate && lowCut && presenceBoost && compressor && limiter) {
    processingSource.connect(highPass);
    highPass.connect(adaptiveNoiseGate);
    adaptiveNoiseGate.connect(lowCut);
    lowCut.connect(presenceBoost);
    presenceBoost.connect(compressor);
    compressor.connect(limiter);
    limiter.connect(destination);
  } else {
    source.connect(destination);
  }
  source.connect(analyser);

  const outputTrack = destination.stream.getAudioTracks()[0];
  if (outputTrack) {
    void outputTrack.applyConstraints({
      sampleRate: 48_000,
      channelCount: 1,
    }).catch(() => undefined);
  }

  if (context.state === "suspended") {
    await context.resume().catch(() => undefined);
  }

  const sampleBuffer = new Float32Array(analyser.fftSize);
  let rafId: number | null = null;
  let noiseFloorDb = -62;
  let lowVolumeScore = 0;
  let clippingScore = 0;
  let noiseScore = 0;
  let distortionScore = 0;
  let lastQualityEmitAt = 0;

  const tick = (): void => {
    analyser.getFloatTimeDomainData(sampleBuffer as Float32Array<ArrayBuffer>);
    let sumSquares = 0;
    let peak = 0;
    let zeroCrossings = 0;
    let previousSign = sampleBuffer.length > 0 && sampleBuffer[0] >= 0 ? 1 : -1;
    for (let index = 0; index < sampleBuffer.length; index += 1) {
      const sample = sampleBuffer[index];
      const absolute = Math.abs(sample);
      sumSquares += sample * sample;
      if (absolute > peak) {
        peak = absolute;
      }
      const currentSign = sample >= 0 ? 1 : -1;
      if (currentSign !== previousSign) {
        zeroCrossings += 1;
        previousSign = currentSign;
      }
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, sampleBuffer.length));
    const currentDb = 20 * Math.log10(Math.max(rms, 1e-8));
    const currentLevel = toNormalizedLevel(currentDb);
    const zeroCrossRate = zeroCrossings / Math.max(1, sampleBuffer.length);
    const speakingLikely = currentDb >= Math.max(-42, noiseFloorDb + 10);

    if (!speakingLikely) {
      noiseFloorDb = clamp((noiseFloorDb * 0.98) + (currentDb * 0.02), -85, -40);
    }

    if (adaptiveNoiseGate) {
      const noiseGateThresholdDb = noiseFloorDb + 8;
      const gateOpen = currentDb >= noiseGateThresholdDb;
      const gateTargetGain = gateOpen ? NOISE_GATE_OPEN_GAIN : NOISE_GATE_CLOSED_GAIN;
      adaptiveNoiseGate.gain.setTargetAtTime(gateTargetGain, context.currentTime, gateOpen ? 0.015 : 0.06);
    }

    const clipping = peak >= 0.985;
    const lowVolume = speakingLikely && currentDb <= -42;
    const excessiveNoise = !speakingLikely && currentDb >= Math.max(-52, noiseFloorDb + 9);
    const distortion = clipping || (zeroCrossRate >= 0.25 && rms >= 0.09);

    lowVolumeScore = clamp(lowVolumeScore + (lowVolume ? 1 : -0.35), 0, 20);
    clippingScore = clamp(clippingScore + (clipping ? 1.6 : -0.5), 0, 20);
    noiseScore = clamp(noiseScore + (excessiveNoise ? 1 : -0.3), 0, 20);
    distortionScore = clamp(distortionScore + (distortion ? 1 : -0.25), 0, 20);

    let warningMessage: string | null = null;
    if (clippingScore >= 4) {
      warningMessage = "Seu microfone pode estar com qualidade baixa (clipping detectado).";
    } else if (distortionScore >= 8) {
      warningMessage = "Seu microfone pode estar com qualidade baixa (distorcao detectada).";
    } else if (noiseScore >= 10) {
      warningMessage = "Seu microfone pode estar com qualidade baixa (ruido de fundo elevado).";
    } else if (lowVolumeScore >= 10) {
      warningMessage = "Seu microfone pode estar com qualidade baixa (volume muito baixo).";
    }

    const now = performance.now();
    if (options.onQuality && now - lastQualityEmitAt >= QUALITY_EMIT_INTERVAL_MS) {
      lastQualityEmitAt = now;
      options.onQuality({
        level: currentLevel,
        noiseLevel: toNormalizedLevel(noiseFloorDb),
        clipping,
        lowVolume,
        excessiveNoise,
        distortion,
        warningMessage,
      });
    }

    rafId = window.requestAnimationFrame(tick);
  };

  tick();

  return {
    stream: destination.stream,
    stop: () => {
      if (rafId != null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      source.disconnect();
      rnnoiseNode?.disconnect();
      rnnoiseNode?.destroy();
      highPass?.disconnect();
      adaptiveNoiseGate?.disconnect();
      lowCut?.disconnect();
      presenceBoost?.disconnect();
      compressor?.disconnect();
      limiter?.disconnect();
      analyser.disconnect();
      destination.disconnect();
      destination.stream.getTracks().forEach((track) => track.stop());
      void context.close().catch(() => undefined);
    },
  };
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
    muted?: boolean;
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
    muted?: boolean;
  },
): void {
  const requestedOutputVolumePercent = Number(options?.outputVolumePercent ?? 100);
  const normalizedOutputVolumePercent = Number.isFinite(requestedOutputVolumePercent)
    ? Math.max(0, Math.min(200, requestedOutputVolumePercent))
    : 100;
  audioElement.volume = Math.max(0, Math.min(1, normalizedOutputVolumePercent / 100));
  if (typeof options?.muted === "boolean") {
    audioElement.muted = options.muted;
  }

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

export function setRemoteAudioPlaybackMuted(
  targetMap: Map<string, HTMLAudioElement>,
  muted: boolean,
): void {
  for (const audioElement of targetMap.values()) {
    audioElement.muted = muted;
  }
}
