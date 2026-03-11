import { useEffect, useMemo, useRef, useState, type ImgHTMLAttributes } from "react";
import { toCdnUrl } from "../../config/domains";
import { getDefaultAvatarUrl, getNameAvatarUrl, isDefaultAvatarUrl } from "../../services/cdn/mediaUrls";

type AvatarImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string | null;
  name?: string | null;
  seed?: string | null;
  fallbackMode?: "name" | "default";
};

const TRANSIENT_FALLBACK_DELAY_MS = 1_200;

function normalizeLocalMediaUrl(src: string): string {
  if (typeof window === "undefined") {
    return src;
  }

  const hostname = String(window.location.hostname ?? "").trim().toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") {
    return src;
  }

  try {
    const parsed = new URL(src);
    if (parsed.hostname !== "cdn.messly.site") {
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
    clearFallbackTimer();
    setResolvedSrc(preferredSrc || fallbackSrc);
  }, [fallbackSrc, identityKey, preferredSrc]);

  useEffect(() => {
    clearFallbackTimer();

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
        if (resolvedSrc !== fallbackSrc) {
          clearFallbackTimer();
          setResolvedSrc(fallbackSrc);
        }
        onError?.(event);
      }}
    />
  );
}
