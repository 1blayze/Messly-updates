const HEX_BANNER_COLOR_REGEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export const DEFAULT_BANNER_COLOR = "#1f2a44";

export function normalizeBannerColor(rawValue: string | null | undefined): string | null {
  const trimmed = String(rawValue ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!HEX_BANNER_COLOR_REGEX.test(withHash)) {
    return null;
  }

  if (withHash.length === 4) {
    const shortValue = withHash.slice(1);
    return `#${Array.from(shortValue, (char) => `${char}${char}`).join("")}`.toLowerCase();
  }

  return withHash.toLowerCase();
}

export function getBannerColorInputValue(rawValue: string | null | undefined): string {
  return (normalizeBannerColor(rawValue) ?? DEFAULT_BANNER_COLOR).toUpperCase();
}
