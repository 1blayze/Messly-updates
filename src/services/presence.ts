import { readCachedPresence, writeCachedPresence } from "../realtime/cache";
import { mapPresenceSnapshotToEntity } from "../stores/entities";
import { presenceActions } from "../stores/presenceSlice";
import { messlyStore } from "../stores/store";
import { presenceStore } from "./presence/presenceStore";

class PresenceService {
  private trackedUserIds = new Set<string>();
  private stopWatching: (() => void) | null = null;
  private unsubscribeStore: (() => void) | null = null;

  async start(currentUserId: string): Promise<void> {
    const cachedPresence = await readCachedPresence();
    if (cachedPresence) {
      messlyStore.dispatch(presenceActions.presenceHydrated(Object.values(cachedPresence)));
    }

    if (!this.unsubscribeStore) {
      this.unsubscribeStore = presenceStore.subscribe(() => {
        void this.syncTrackedUsersFromLegacyStore();
      });
    }

    this.trackUsers([currentUserId]);
  }

  stop(): void {
    this.trackedUserIds.clear();
    this.stopWatching?.();
    this.stopWatching = null;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
  }

  trackUsers(userIds: string[]): void {
    let changed = false;
    userIds.forEach((userId) => {
      const normalized = String(userId ?? "").trim();
      if (!normalized || this.trackedUserIds.has(normalized)) {
        return;
      }
      this.trackedUserIds.add(normalized);
      changed = true;
    });

    if (!changed) {
      return;
    }

    this.stopWatching?.();
    this.stopWatching = presenceStore.watchUsers([...this.trackedUserIds]);
  }

  private async syncTrackedUsersFromLegacyStore(): Promise<void> {
    const trackedPresence = [...this.trackedUserIds].map((userId) => {
      return mapPresenceSnapshotToEntity(presenceStore.getPresenceSnapshot(userId));
    });

    trackedPresence.forEach((presence) => {
      messlyStore.dispatch(presenceActions.presenceUpserted(presence));
    });
    await this.persistCache();
  }

  private async persistCache(): Promise<void> {
    const state = messlyStore.getState().presence;
    const byUserId = Object.fromEntries(
      state.ids
        .map((id) => state.entities[id])
        .filter(Boolean)
        .map((presence) => [presence.userId, presence]),
    );
    await writeCachedPresence(byUserId);
  }
}

export const presenceService = new PresenceService();
