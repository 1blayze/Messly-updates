export interface VoiceActivityDetectorOptions {
  fftSize?: number;
  thresholdDb?: number;
  speakingHangMs?: number;
  smoothingTimeConstant?: number;
  onSpeakingChange?: (speaking: boolean, level: number) => void;
  onLevel?: (level: number) => void;
}

const DEFAULT_FFT_SIZE = 1024;
const DEFAULT_THRESHOLD_DB = -52;
const DEFAULT_SPEAKING_HANG_MS = 220;
const DEFAULT_SMOOTHING = 0.15;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toNormalizedLevel(db: number): number {
  // Map roughly [-72dB, -18dB] into [0, 1]
  return clamp((db + 72) / 54, 0, 1);
}

export class VoiceActivityDetector {
  private readonly stream: MediaStream;
  private readonly options: Required<Omit<VoiceActivityDetectorOptions, "onSpeakingChange" | "onLevel">>;
  private readonly onSpeakingChange: ((speaking: boolean, level: number) => void) | null;
  private readonly onLevel: ((level: number) => void) | null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private sampleBuffer: Float32Array | null = null;
  private rafId: number | null = null;
  private speaking = false;
  private lastAboveThresholdAt = 0;

  constructor(stream: MediaStream, options: VoiceActivityDetectorOptions = {}) {
    this.stream = stream;
    this.options = {
      fftSize: options.fftSize ?? DEFAULT_FFT_SIZE,
      thresholdDb: options.thresholdDb ?? DEFAULT_THRESHOLD_DB,
      speakingHangMs: options.speakingHangMs ?? DEFAULT_SPEAKING_HANG_MS,
      smoothingTimeConstant: options.smoothingTimeConstant ?? DEFAULT_SMOOTHING,
    };
    this.onSpeakingChange = options.onSpeakingChange ?? null;
    this.onLevel = options.onLevel ?? null;
  }

  async start(): Promise<void> {
    if (this.context) {
      return;
    }

    const AudioContextCtor =
      (window as Window & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    const context = new AudioContextCtor();
    const source = context.createMediaStreamSource(this.stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = this.options.fftSize;
    analyser.smoothingTimeConstant = this.options.smoothingTimeConstant;
    source.connect(analyser);

    this.context = context;
    this.source = source;
    this.analyser = analyser;
    this.sampleBuffer = new Float32Array(analyser.fftSize);

    if (context.state === "suspended") {
      await context.resume().catch(() => undefined);
    }

    this.tick();
  }

  stop(): void {
    if (this.rafId != null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    this.source?.disconnect();
    this.analyser?.disconnect();
    this.source = null;
    this.analyser = null;
    this.sampleBuffer = null;

    const context = this.context;
    this.context = null;
    if (context) {
      void context.close().catch(() => undefined);
    }

    if (this.speaking) {
      this.speaking = false;
      this.onSpeakingChange?.(false, 0);
    }
  }

  private tick = (): void => {
    const analyser = this.analyser;
    const sampleBuffer = this.sampleBuffer;
    if (!analyser || !sampleBuffer) {
      return;
    }

    analyser.getFloatTimeDomainData(sampleBuffer as Float32Array<ArrayBuffer>);
    let sumSquares = 0;
    for (let index = 0; index < sampleBuffer.length; index += 1) {
      const sample = sampleBuffer[index];
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / sampleBuffer.length);
    const db = 20 * Math.log10(Math.max(rms, 1e-8));
    const level = toNormalizedLevel(db);
    this.onLevel?.(level);

    const now = performance.now();
    if (db >= this.options.thresholdDb) {
      this.lastAboveThresholdAt = now;
    }

    const shouldSpeak = db >= this.options.thresholdDb || now - this.lastAboveThresholdAt <= this.options.speakingHangMs;
    if (shouldSpeak !== this.speaking) {
      this.speaking = shouldSpeak;
      this.onSpeakingChange?.(shouldSpeak, level);
    }

    this.rafId = window.requestAnimationFrame(this.tick);
  };
}
