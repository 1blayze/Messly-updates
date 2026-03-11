import { useEffect, useMemo, useRef, useState, type ImgHTMLAttributes } from "react";
import { toCdnUrl } from "../../config/domains";
import {
  getDefaultAvatarUrl,
  getNameAvatarUrl,
  isDefaultAvatarUrl,
  refreshFailedSignedMediaUrl,
} from "../../services/cdn/mediaUrls";

type AvatarImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string | null;
  name?: string | null;
  seed?: string | null;
  fallbackMode?: "name" | "default";
};

const TRANSIENT_FALLBACK_DELAY_MS = 1_200;

function normalizeLocalMediaUrl(src: string): string {
  try {
    const parsed = new URL(src);
    if (parsed.hostname.toLowerCase() !== "cdn.messly.site") {
      return src;
    }

    const normalizedKey = parsed.pathname.replace(/^\/+/, "");
    const rewritten = new URL(toCdnUrl(normalizedKey));
    parsed.searchParams.forEach((value, key) => {
      rewritten.searchParams.set(key, value);
    });
    return rewritten.toString();
  } catch {
    return src;
  }
}

function sanitizeAvatarSrc(srcRaw: string | null | undefined): string {
  const src = String(srcRaw ?? "").trim();
  if (!src || isDefaultAvatarUrl(src)) {
    return "";
  }
  return normalizeLocalMediaUrl(src);
}

export default function AvatarImage({
  src,
  name,
  seed,
  fallbackMode = "name",
  onError,
  alt,
  ...imgProps
}: AvatarImageProps) {
  const fallbackSrc = useMemo(() => {
    const fallbackSeed = String(seed ?? "").trim() || String(name ?? "").trim() || "default-avatar";
    if (fallbackMode === "default") {
      return getDefaultAvatarUrl(fallbackSeed);
    }
    return getNameAvatarUrl(fallbackSeed);
  }, [fallbackMode, name, seed]);
  const preferredSrc = useMemo(() => sanitizeAvatarSrc(src), [src]);
  const identityKey = useMemo(
    () => `${String(seed ?? "").trim().toLowerCase()}::${String(name ?? "").trim().toLowerCase()}`,
    [name, seed],
  );
  const [resolvedSrc, setResolvedSrc] = useState<string>(() => preferredSrc || fallbackSrc);
  const fallbackTimerRef = useRef<number | null>(null);
  const refreshAttemptedSrcRef = useRef<string>("");
  const preferredSrcRef = useRef<string>(preferredSrc);
  const identityKeyRef = useRef<string>(identityKey);

  const clearFallbackTimer = (): void => {
    if (fallbackTimerRef.current !== null) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  };

  useEffect(() => {
    preferredSrcRef.current = preferredSrc;
  }, [preferredSrc]);

  useEffect(() => {
    if (identityKeyRef.current === identityKey) {
      return;
    }
    identityKeyRef.current = identityKey;
    refreshAttemptedSrcRef.current = "";
    clearFallbackTimer();
    setResolvedSrc(preferredSrc || fallbackSrc);
  }, [fallbackSrc, identityKey, preferredSrc]);

  useEffect(() => {
    clearFallbackTimer();
    refreshAttemptedSrcRef.current = "";

    if (preferredSrc) {
      setResolvedSrc((current) => (current === preferredSrc ? current : preferredSrc));
      return;
    }

    // Keep the last valid avatar briefly while signed URLs refresh.
    setResolvedSrc((current) => {
      const currentSrc = String(current ?? "").trim();
      if (currentSrc) {
        return currentSrc;
      }
      return fallbackSrc;
    });
    fallbackTimerRef.current = window.setTimeout(() => {
      if (preferredSrcRef.current) {
        return;
      }
      setResolvedSrc(fallbackSrc);
    }, TRANSIENT_FALLBACK_DELAY_MS);

    return () => {
      clearFallbackTimer();
    };
  }, [preferredSrc, fallbackSrc]);

  useEffect(() => {
    return () => {
      clearFallbackTimer();
    };
  }, []);

  return (
    <img
      {...imgProps}
      src={resolvedSrc}
      alt={alt ?? `Avatar de ${String(name ?? "").trim() || "usuario"}`}
      onError={(event) => {
        const failedSrc = String(resolvedSrc ?? "").trim();
        if (!failedSrc || failedSrc === fallbackSrc) {
          onError?.(event);
          return;
        }

        if (refreshAttemptedSrcRef.current !== failedSrc) {
          refreshAttemptedSrcRef.current = failedSrc;
          void refreshFailedSignedMediaUrl(failedSrc)
            .then((refreshedSrc) => {
              setResolvedSrc((current) => {
                if (String(current ?? "").trim() !== failedSrc) {
                  return current;
                }
                const normalizedRefreshed = String(refreshedSrc ?? "").trim();
                if (normalizedRefreshed && normalizedRefreshed !== failedSrc) {
                  return normalizedRefreshed;
                }
                return fallbackSrc;
              });
            })
            .catch(() => {
              setResolvedSrc((current) => (String(current ?? "").trim() === failedSrc ? fallbackSrc : current));
            });
        } else {
          clearFallbackTimer();
          setResolvedSrc(fallbackSrc);
        }

        onError?.(event);
      }}
    />
  );
}
