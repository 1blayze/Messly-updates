import type { CSSProperties } from "react";

export type MaterialSymbolIconWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700;
export type MaterialSymbolIconOpsz = 20 | 24 | 40 | 48;

export interface MaterialSymbolIconProps {
  name: string;
  size?: number;
  filled?: boolean;
  weight?: MaterialSymbolIconWeight;
  grade?: number;
  opsz?: MaterialSymbolIconOpsz;
  className?: string;
  title?: string;
}

export default function MaterialSymbolIcon({
  name,
  size = 20,
  filled = true,
  weight = 400,
  grade = 0,
  opsz = 24,
  className,
  title,
}: MaterialSymbolIconProps) {
  const classes = ["ms-icon", className].filter(Boolean).join(" ");
  const style = {
    fontSize: size,
    "--ms-fill": filled ? 1 : 0,
    "--ms-wght": weight,
    "--ms-grad": grade,
    "--ms-opsz": opsz,
  } as CSSProperties & Record<string, string | number>;

  const accessibilityProps = title
    ? { role: "img", "aria-label": title, title }
    : { "aria-hidden": true };

  return (
    <span className={classes} style={style} {...accessibilityProps}>
      {name}
    </span>
  );
}
