import type { CSSProperties } from "react";

interface SpotifyIconProps {
  className?: string;
  size?: number;
  title?: string;
  monochrome?: boolean;
}

const spotifyIconUrl = new URL("../../assets/icons/ui/spotify.svg", import.meta.url).href;

export default function SpotifyIcon({
  className,
  size = 20,
  title,
  monochrome = false,
}: SpotifyIconProps) {
  const resolvedSize = Number.isFinite(size) ? Math.max(8, Math.round(size)) : 20;
  const accessibilityProps = title
    ? { role: "img", "aria-label": title, title }
    : { "aria-hidden": true };

  if (monochrome) {
    const style = {
      width: `${resolvedSize}px`,
      height: `${resolvedSize}px`,
      minWidth: `${resolvedSize}px`,
      minHeight: `${resolvedSize}px`,
      backgroundColor: "currentColor",
      WebkitMaskImage: `url("${spotifyIconUrl}")`,
      maskImage: `url("${spotifyIconUrl}")`,
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
      WebkitMaskPosition: "center",
      maskPosition: "center",
      WebkitMaskSize: "contain",
      maskSize: "contain",
      display: "inline-flex",
      flex: "0 0 auto",
      verticalAlign: "middle",
    } as CSSProperties;

    return <span className={className} style={style} {...accessibilityProps} />;
  }

  return <img className={className} src={spotifyIconUrl} width={resolvedSize} height={resolvedSize} alt={title ?? ""} aria-hidden={title ? undefined : true} />;
}
