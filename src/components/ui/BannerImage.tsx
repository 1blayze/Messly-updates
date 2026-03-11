import { useEffect, useMemo, useState, type ImgHTMLAttributes } from "react";
import { toCdnUrl } from "../../config/domains";
import { getDefaultBannerUrl } from "../../services/cdn/mediaUrls";

type BannerImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string | null;
};

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

function sanitizeBannerSrc(srcRaw: string | null | undefined): string {
  const src = String(srcRaw ?? "").trim();
  if (!src) {
    return "";
  }

  const isAbsolute =
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:") ||
    src.startsWith("blob:");

  return isAbsolute ? normalizeLocalMediaUrl(src) : "";
}

export default function BannerImage({ src, onError, alt = "", ...imgProps }: BannerImageProps) {
  const fallbackSrc = useMemo(() => getDefaultBannerUrl(), []);
  const preferredSrc = useMemo(() => sanitizeBannerSrc(src), [src]);
  const [resolvedSrc, setResolvedSrc] = useState<string>(() => preferredSrc || fallbackSrc);

  useEffect(() => {
    setResolvedSrc(preferredSrc || fallbackSrc);
  }, [preferredSrc, fallbackSrc]);

  return (
    <img
      {...imgProps}
      src={resolvedSrc}
      alt={alt}
      onError={(event) => {
        if (resolvedSrc !== fallbackSrc) {
          setResolvedSrc(fallbackSrc);
        }
        onError?.(event);
      }}
    />
  );
}
