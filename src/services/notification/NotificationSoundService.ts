import notificationSoundUrl from "../../assets/sounds/notification.mp3";

const DEFAULT_NOTIFICATION_SOUND_VOLUME = 0.8;

class NotificationSoundService {
  private baseAudio: HTMLAudioElement | null = null;

  private readonly soundUrl = notificationSoundUrl;

  private readonly volume = DEFAULT_NOTIFICATION_SOUND_VOLUME;

  play(): void {
    const audio = this.getOrCreateBaseAudio();
    if (!audio) {
      return;
    }

    const playbackInstance = audio.cloneNode(true) as HTMLAudioElement;
    playbackInstance.volume = this.volume;
    playbackInstance.preload = "auto";
    void playbackInstance.play().catch(() => {
      // Ignore playback rejections (autoplay policies / transient device errors).
    });
  }

  dispose(): void {
    if (!this.baseAudio) {
      return;
    }
    this.baseAudio.pause();
    this.baseAudio.src = "";
    this.baseAudio = null;
  }

  private getOrCreateBaseAudio(): HTMLAudioElement | null {
    if (typeof window === "undefined") {
      return null;
    }

    if (!this.baseAudio) {
      const audio = new Audio(this.soundUrl);
      audio.preload = "auto";
      audio.volume = this.volume;
      this.baseAudio = audio;
    }

    return this.baseAudio;
  }
}

export const notificationSoundService = new NotificationSoundService();
