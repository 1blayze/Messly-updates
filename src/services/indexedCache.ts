const CACHE_DB_NAME = "messly-cache";
const CACHE_STORE_NAME = "kv";
const CACHE_VERSION = 1;

interface CacheRecord<T> {
  value: T;
  expiresAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openCacheDatabase(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, CACHE_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        db.createObjectStore(CACHE_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });

  return dbPromise;
}

function createTimeoutPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error("IndexedDB timeout"));
    }, timeoutMs);

    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

export async function setCachedValue<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const db = await createTimeoutPromise(openCacheDatabase(), 1200);
  await createTimeoutPromise(
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readwrite");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const payload: CacheRecord<T> = {
        value,
        expiresAt: Date.now() + ttlMs,
      };

      const request = store.put(payload, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB write failed"));
    }),
    1200,
  );
}

export async function getCachedValue<T>(key: string): Promise<T | null> {
  const db = await createTimeoutPromise(openCacheDatabase(), 1200);
  const record = await createTimeoutPromise(
    new Promise<CacheRecord<T> | null>((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readonly");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const result = (request.result as CacheRecord<T> | undefined) ?? null;
        resolve(result);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    }),
    1200,
  );

  if (!record) {
    return null;
  }

  if (Date.now() > record.expiresAt) {
    void deleteCachedValue(key);
    return null;
  }

  return record.value;
}

export async function deleteCachedValue(key: string): Promise<void> {
  const db = await createTimeoutPromise(openCacheDatabase(), 1200);
  await createTimeoutPromise(
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readwrite");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB delete failed"));
    }),
    1200,
  );
}

export async function setPersistentValue<T>(key: string, value: T): Promise<void> {
  const db = await createTimeoutPromise(openCacheDatabase(), 1200);
  await createTimeoutPromise(
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readwrite");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const payload: CacheRecord<T> = {
        value,
        expiresAt: Number.POSITIVE_INFINITY,
      };

      const request = store.put(payload, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB write failed"));
    }),
    1200,
  );
}

export async function getPersistentValue<T>(key: string): Promise<T | null> {
  const db = await createTimeoutPromise(openCacheDatabase(), 1200);
  const record = await createTimeoutPromise(
    new Promise<CacheRecord<T> | null>((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readonly");
      const store = tx.objectStore(CACHE_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => {
        const result = (request.result as CacheRecord<T> | undefined) ?? null;
        resolve(result);
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    }),
    1200,
  );

  return record?.value ?? null;
}

export async function deletePersistentValue(key: string): Promise<void> {
  await deleteCachedValue(key);
}
