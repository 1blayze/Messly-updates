export interface VoiceActivityDetectorOptions {
  fftSize?: number;
  thresholdDb?: number;
  speakingHangMs?: number;
  smoothingTimeConstant?: number;
  minVoiceBandRatio?: number;
  maxHighBandRatio?: number;
  minZeroCrossingRate?: number;
  maxZeroCrossingRate?: number;
  confidenceAttack?: number;
  confidenceRelease?: number;
  openConfidenceThreshold?: number;
  onSpeakingChange?: (speaking: boolean, level: number) => void;
  onLevel?: (level: number) => void;
}

const DEFAULT_FFT_SIZE = 1024;
const DEFAULT_THRESHOLD_DB = -54;
const DEFAULT_SPEAKING_HANG_MS = 300;
const DEFAULT_SMOOTHING = 0.08;
const DEFAULT_MIN_VOICE_BAND_RATIO = 0.3;
const DEFAULT_MAX_HIGH_BAND_RATIO = 0.56;
const DEFAULT_MIN_ZERO_CROSSING_RATE = 0.02;
const DEFAULT_MAX_ZERO_CROSSING_RATE = 0.24;
const DEFAULT_CONFIDENCE_ATTACK = 0.24;
const DEFAULT_CONFIDENCE_RELEASE = 0.055;
const DEFAULT_OPEN_CONFIDENCE_THRESHOLD = 0.28;
const SPEECH_BAND_MIN_HZ = 220;
const SPEECH_BAND_MAX_HZ = 4_200;
const HIGH_BAND_MIN_HZ = 4_800;
const HIGH_BAND_MAX_HZ = 12_000;
const VOICE_PEAK_IMPULSE_THRESHOLD = 0.7;
const VOICE_CREST_IMPULSE_THRESHOLD = 6.4;
const VOICE_DB_JUMP_IMPULSE_THRESHOLD = 7;
const NOISE_FLOOR_ATTACK = 0.03;
const NOISE_FLOOR_RELEASE = 0.98;

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
  private frequencyBuffer: Float32Array | null = null;
  private rafId: number | null = null;
  private speaking = false;
  private lastAboveThresholdAt = 0;
  private speechConfidence = 0;
  private noiseFloorDb = -62;
  private previousDb = -90;

  constructor(stream: MediaStream, options: VoiceActivityDetectorOptions = {}) {
    this.stream = stream;
    this.options = {
      fftSize: options.fftSize ?? DEFAULT_FFT_SIZE,
      thresholdDb: options.thresholdDb ?? DEFAULT_THRESHOLD_DB,
      speakingHangMs: options.speakingHangMs ?? DEFAULT_SPEAKING_HANG_MS,
      smoothingTimeConstant: options.smoothingTimeConstant ?? DEFAULT_SMOOTHING,
      minVoiceBandRatio: options.minVoiceBandRatio ?? DEFAULT_MIN_VOICE_BAND_RATIO,
      maxHighBandRatio: options.maxHighBandRatio ?? DEFAULT_MAX_HIGH_BAND_RATIO,
      minZeroCrossingRate: options.minZeroCrossingRate ?? DEFAULT_MIN_ZERO_CROSSING_RATE,
      maxZeroCrossingRate: options.maxZeroCrossingRate ?? DEFAULT_MAX_ZERO_CROSSING_RATE,
      confidenceAttack: options.confidenceAttack ?? DEFAULT_CONFIDENCE_ATTACK,
      confidenceRelease: options.confidenceRelease ?? DEFAULT_CONFIDENCE_RELEASE,
      openConfidenceThreshold: options.openConfidenceThreshold ?? DEFAULT_OPEN_CONFIDENCE_THRESHOLD,
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
    this.frequencyBuffer = new Float32Array(analyser.frequencyBinCount);

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
    this.frequencyBuffer = null;

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
    const frequencyBuffer = this.frequencyBuffer;
    const context = this.context;
    if (!analyser || !sampleBuffer || !frequencyBuffer || !context) {
      return;
    }

    analyser.getFloatTimeDomainData(sampleBuffer as Float32Array<ArrayBuffer>);
    analyser.getFloatFrequencyData(frequencyBuffer as Float32Array<ArrayBuffer>);
    let sumSquares = 0;
    let peak = 0;
    let zeroCrossings = 0;
    let previousSign = sampleBuffer.length > 0 && sampleBuffer[0] >= 0 ? 1 : -1;
    for (let index = 0; index < sampleBuffer.length; index += 1) {
      const sample = sampleBuffer[index];
      sumSquares += sample * sample;
      const absoluteSample = Math.abs(sample);
      if (absoluteSample > peak) {
        peak = absoluteSample;
      }
      const currentSign = sample >= 0 ? 1 : -1;
      if (currentSign !== previousSign) {
        zeroCrossings += 1;
        previousSign = currentSign;
      }
    }

    const rms = Math.sqrt(sumSquares / sampleBuffer.length);
    const db = 20 * Math.log10(Math.max(rms, 1e-8));
    const dbJump = db - this.previousDb;
    this.previousDb = db;
    const level = toNormalizedLevel(db);
    this.onLevel?.(level);

    let speechBandEnergy = 0;
    let highBandEnergy = 0;
    let totalEnergy = 0;
    const nyquist = context.sampleRate / 2;
    const binWidthHz = nyquist / Math.max(1, frequencyBuffer.length - 1);
    for (let index = 0; index < frequencyBuffer.length; index += 1) {
      const magnitudeLinear = 10 ** ((frequencyBuffer[index] ?? -100) / 20);
      if (!Number.isFinite(magnitudeLinear) || magnitudeLinear <= 0) {
        continue;
      }
      totalEnergy += magnitudeLinear;
      const frequencyHz = index * binWidthHz;
      if (frequencyHz >= SPEECH_BAND_MIN_HZ && frequencyHz <= SPEECH_BAND_MAX_HZ) {
        speechBandEnergy += magnitudeLinear;
      }
      if (frequencyHz >= HIGH_BAND_MIN_HZ && frequencyHz <= HIGH_BAND_MAX_HZ) {
        highBandEnergy += magnitudeLinear;
      }
    }

    const speechBandRatio = speechBandEnergy / Math.max(totalEnergy, 1e-6);
    const highBandRatio = highBandEnergy / Math.max(totalEnergy, 1e-6);
    const zeroCrossingRate = zeroCrossings / Math.max(1, sampleBuffer.length);
    const crestFactor = peak / Math.max(rms, 1e-5);

    if (db < this.options.thresholdDb || speechBandRatio < this.options.minVoiceBandRatio) {
      const adaptive = (this.noiseFloorDb * NOISE_FLOOR_RELEASE) + (db * NOISE_FLOOR_ATTACK);
      this.noiseFloorDb = clamp(adaptive, -85, -38);
    }

    const dynamicVoiceThreshold = Math.max(this.options.thresholdDb, this.noiseFloorDb + 8);
    const likelyTransientImpulse =
      peak >= VOICE_PEAK_IMPULSE_THRESHOLD
      && crestFactor >= VOICE_CREST_IMPULSE_THRESHOLD
      && dbJump >= VOICE_DB_JUMP_IMPULSE_THRESHOLD
      && highBandRatio >= 0.32
      && speechBandRatio < 0.58;

    const likelyHumanVoice =
      db >= dynamicVoiceThreshold
      && speechBandRatio >= this.options.minVoiceBandRatio
      && highBandRatio <= this.options.maxHighBandRatio
      && zeroCrossingRate >= this.options.minZeroCrossingRate
      && zeroCrossingRate <= this.options.maxZeroCrossingRate
      && crestFactor <= 8.4
      && !likelyTransientImpulse;

    this.speechConfidence = clamp(
      this.speechConfidence + (likelyHumanVoice ? this.options.confidenceAttack : -this.options.confidenceRelease),
      0,
      1,
    );

    const now = performance.now();
    if (likelyHumanVoice && this.speechConfidence >= this.options.openConfidenceThreshold) {
      this.lastAboveThresholdAt = now;
    }

    const shouldSpeak =
      (likelyHumanVoice && this.speechConfidence >= this.options.openConfidenceThreshold)
      || now - this.lastAboveThresholdAt <= this.options.speakingHangMs;
    if (shouldSpeak !== this.speaking) {
      this.speaking = shouldSpeak;
      this.onSpeakingChange?.(shouldSpeak, level);
    }

    this.rafId = window.requestAnimationFrame(this.tick);
  };
}
