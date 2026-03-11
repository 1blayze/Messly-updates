import type { CSSProperties } from "react";
import { normalizeBannerColor } from "./bannerColor";

export type ProfileThemeMode = "dark" | "light";

interface OklchColor {
  l: number;
  c: number;
  h: number;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface Rgb255Color {
  r: number;
  g: number;
  b: number;
}

interface HslColor {
  h: number;
  s: number;
  l: number;
}

type ContrastDirection = "lighter" | "darker";

export interface ProfileSurfaceScale {
  modalBg: string;
  surface: string;
  surface2: string;
  surface3: string;
  raw: {
    modalBg: OklchColor;
    surface: OklchColor;
    surface2: OklchColor;
    surface3: OklchColor;
  };
}

export interface CreateProfileThemeInput {
  primaryColor: string;
  accentColor: string;
  mode: ProfileThemeMode;
}

export interface ProfileThemeTokens {
  "--profile-primary": string;
  "--profile-banner-bg": string;
  "--profile-body-base": string;
  "--profile-body-sheen": string;
  "--profile-body-depth": string;
  "--profile-glow": string;
  "--profile-separator": string;
  "--profile-card-bg": string;
  "--profile-body-bg": string;
  "--profile-body-glow": string;
  "--profile-border-top": string;
  "--profile-overlay-alpha": string;
  "--profile-modal-bg": string;
  "--profile-shell-bg": string;
  "--profile-shell-border-gradient": string;
  "--profile-bg": string;
  "--profile-bg-overlay": string;
  "--profile-surface": string;
  "--profile-surface-2": string;
  "--profile-surface-3": string;
  "--profile-border": string;
  "--profile-divider": string;
  "--profile-text": string;
  "--profile-muted": string;
  "--profile-text-muted": string;
  "--profile-accent": string;
  "--profile-accent-soft": string;
  "--profile-accent-strong": string;
  "--profile-button-bg": string;
  "--profile-button-bg-hover": string;
  "--profile-button-bg-active": string;
  "--profile-button-text": string;
  "--profile-focus-ring": string;
  "--profile-shadow-sm": string;
  "--profile-shadow-md": string;
  "--profile-on-accent": string;
  "--profile-link": string;
  "--profile-link-hover": string;
  "--profile-hover-surface": string;
  "--profile-input-bg": string;
  "--profile-overlay": string;
  "--profile-overlay-hover": string;
  "--profile-menu-surface": string;
  "--profile-menu-shadow": string;
  "--profile-danger": string;
  "--profile-danger-soft": string;
  "--profile-danger-text": string;
  "--profile-positive": string;
  "--profile-positive-soft": string;
  "--profile-spotify-progress": string;
  "--profile-selection": string;
  "--profile-scrollbar-thumb": string;
  "--profile-scrollbar-thumb-hover": string;
  "--profile-presence-online": string;
  "--profile-presence-idle": string;
  "--profile-presence-dnd": string;
  "--profile-presence-invisible": string;
  "--profile-badge-gradient-1": string;
  "--profile-badge-gradient-2": string;
  "--profile-badge-gradient-3": string;
  "--profile-transition-fast": string;
  "--profile-transition-standard": string;
}

export type ProfileThemeTokenName = keyof ProfileThemeTokens;
export type ProfileThemeInlineStyle = CSSProperties & Partial<Record<ProfileThemeTokenName, string>>;

export interface ProfileTheme {
  mode: ProfileThemeMode;
  isGraphiteMode: boolean;
  normalizedPrimary: string;
  normalizedAccent: string;
  bannerColor: string;
  surfaces: ProfileSurfaceScale;
  tokens: ProfileThemeTokens;
  style: ProfileThemeInlineStyle;
}

export interface BuiltProfileTheme {
  mode: ProfileThemeMode;
  primaryHex: string;
  accentHex: string;
  bodyBaseHex: string;
  bodyBgHex: string;
  bodyGlow: string;
  overlayAlpha: number;
  textHex: string;
  mutedHex: string;
  borderColor: string;
  borderTopColor: string;
  dividerColor: string;
  buttonBgHex: string;
  buttonHoverHex: string;
  buttonActiveHex: string;
  buttonTextHex: string;
  linkHex: string;
  focusRing: string;
  shellBgHex: string;
  isGraphiteMode: boolean;
  variables: Pick<
    ProfileThemeTokens,
    | "--profile-primary"
    | "--profile-accent"
    | "--profile-banner-bg"
    | "--profile-body-base"
    | "--profile-body-sheen"
    | "--profile-body-depth"
    | "--profile-glow"
    | "--profile-separator"
    | "--profile-card-bg"
    | "--profile-body-bg"
    | "--profile-body-glow"
    | "--profile-border-top"
    | "--profile-overlay-alpha"
    | "--profile-bg"
    | "--profile-bg-overlay"
    | "--profile-text"
    | "--profile-muted"
    | "--profile-button-bg"
    | "--profile-button-bg-hover"
    | "--profile-button-bg-active"
    | "--profile-button-text"
  >;
}

const DEFAULT_PRIMARY: OklchColor = { l: 0.58, c: 0.035, h: 252 };
const DEFAULT_ACCENT: OklchColor = { l: 0.72, c: 0.145, h: 262 };
const DEFAULT_GRAPHITE_HUE = 255;

const WHITE_OKLCH: OklchColor = { l: 1, c: 0, h: 0 };
const BLACK_OKLCH: OklchColor = { l: 0, c: 0, h: 0 };

const WHITE_TEXT = "rgb(255 255 255)";
const BLACK_TEXT = "rgb(0 0 0)";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) return DEFAULT_PRIMARY.h;
  const wrapped = hue % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function normalizeHsl(color: HslColor): HslColor {
  return {
    h: normalizeHue(color.h),
    s: clamp(color.s, 0, 100),
    l: clamp(color.l, 0, 100),
  };
}

function normalizeRgb255(color: Rgb255Color): Rgb255Color {
  return {
    r: Math.round(clamp(color.r, 0, 255)),
    g: Math.round(clamp(color.g, 0, 255)),
    b: Math.round(clamp(color.b, 0, 255)),
  };
}

function rgb255ToUnit(color: Rgb255Color): RgbColor {
  return {
    r: clamp(color.r / 255, 0, 1),
    g: clamp(color.g / 255, 0, 1),
    b: clamp(color.b / 255, 0, 1),
  };
}

function unitRgbTo255(color: RgbColor): Rgb255Color {
  return normalizeRgb255({
    r: color.r * 255,
    g: color.g * 255,
    b: color.b * 255,
  });
}

function rgb255ToHex(color: Rgb255Color): string {
  const normalized = normalizeRgb255(color);
  const toHex = (value: number): string => value.toString(16).padStart(2, "0");
  return `#${toHex(normalized.r)}${toHex(normalized.g)}${toHex(normalized.b)}`;
}

function rgbToHex(color: RgbColor): string {
  return rgb255ToHex(unitRgbTo255(color));
}

function toRgbaString(color: Rgb255Color, alpha: number): string {
  const normalized = normalizeRgb255(color);
  return `rgba(${normalized.r}, ${normalized.g}, ${normalized.b}, ${round(alpha, 3)})`;
}

function hueDistance(a: number, b: number): number {
  const delta = Math.abs(normalizeHue(a) - normalizeHue(b));
  return Math.min(delta, 360 - delta);
}

function isNearNeutralHsl(color: HslColor, threshold = 10): boolean {
  return normalizeHsl(color).s <= threshold;
}

function srgbToLinear(channel: number): number {
  if (channel <= 0.04045) return channel / 12.92;
  return ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  if (channel <= 0.0031308) return channel * 12.92;
  return 1.055 * channel ** (1 / 2.4) - 0.055;
}

export function parseHex(hex: string | null | undefined): Rgb255Color | null {
  const normalized = normalizeBannerColor(hex);
  if (!normalized) return null;
  const raw = normalized.slice(1);
  return {
    r: Number.parseInt(raw.slice(0, 2), 16),
    g: Number.parseInt(raw.slice(2, 4), 16),
    b: Number.parseInt(raw.slice(4, 6), 16),
  };
}

function parseHexColor(rawColor: string | null | undefined): RgbColor | null {
  const parsed = parseHex(rawColor);
  return parsed ? rgb255ToUnit(parsed) : null;
}

export function rgbToHsl(rgb: Rgb255Color): HslColor {
  const normalized = normalizeRgb255(rgb);
  const r = normalized.r / 255;
  const g = normalized.g / 255;
  const b = normalized.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }

  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

  return normalizeHsl({
    h: hue * 60,
    s: saturation * 100,
    l: lightness * 100,
  });
}

export function hslToRgb(hsl: HslColor): Rgb255Color {
  const normalized = normalizeHsl(hsl);
  const saturation = normalized.s / 100;
  const lightness = normalized.l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const huePrime = normalized.h / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (huePrime >= 0 && huePrime < 1) {
    r1 = chroma;
    g1 = x;
  } else if (huePrime < 2) {
    r1 = x;
    g1 = chroma;
  } else if (huePrime < 3) {
    g1 = chroma;
    b1 = x;
  } else if (huePrime < 4) {
    g1 = x;
    b1 = chroma;
  } else if (huePrime < 5) {
    r1 = x;
    b1 = chroma;
  } else {
    r1 = chroma;
    b1 = x;
  }

  const match = lightness - chroma / 2;
  return normalizeRgb255({
    r: (r1 + match) * 255,
    g: (g1 + match) * 255,
    b: (b1 + match) * 255,
  });
}

export function relativeLuminance(rgb: Rgb255Color): number {
  const unit = rgb255ToUnit(rgb);
  const r = srgbToLinear(unit.r);
  const g = srgbToLinear(unit.g);
  const b = srgbToLinear(unit.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(rgb1: Rgb255Color, rgb2: Rgb255Color): number {
  const l1 = relativeLuminance(rgb1);
  const l2 = relativeLuminance(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export function mixColors(source: Rgb255Color, target: Rgb255Color, amount: number): Rgb255Color {
  const t = clamp(amount, 0, 1);
  return normalizeRgb255({
    r: source.r + (target.r - source.r) * t,
    g: source.g + (target.g - source.g) * t,
    b: source.b + (target.b - source.b) * t,
  });
}

export function adjustLightness(color: HslColor, delta: number): HslColor {
  return normalizeHsl({ ...color, l: color.l + delta });
}

export function adjustSaturation(color: HslColor, delta: number): HslColor {
  return normalizeHsl({ ...color, s: color.s + delta });
}

function rgbToOklch(rgb: RgbColor): OklchColor {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const labL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const labA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return {
    l: clamp(labL, 0, 1),
    c: Math.max(0, Math.sqrt(labA ** 2 + labB ** 2)),
    h: normalizeHue((Math.atan2(labB, labA) * 180) / Math.PI),
  };
}

function oklchToRgbUnchecked(color: OklchColor): RgbColor {
  const a = Math.cos((color.h * Math.PI) / 180) * color.c;
  const b = Math.sin((color.h * Math.PI) / 180) * color.c;

  const l = color.l + 0.3963377774 * a + 0.2158037573 * b;
  const m = color.l - 0.1055613458 * a - 0.0638541728 * b;
  const s = color.l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l ** 3;
  const m3 = m ** 3;
  const s3 = s ** 3;

  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const blue = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  return {
    r: linearToSrgb(r),
    g: linearToSrgb(g),
    b: linearToSrgb(blue),
  };
}

function isRgbInGamut(rgb: RgbColor): boolean {
  return rgb.r >= 0 && rgb.r <= 1 && rgb.g >= 0 && rgb.g <= 1 && rgb.b >= 0 && rgb.b <= 1;
}

function clampOklchToGamut(color: OklchColor): OklchColor {
  const normalizedColor = {
    l: clamp(color.l, 0, 1),
    c: Math.max(0, color.c),
    h: normalizeHue(color.h),
  };

  if (normalizedColor.c === 0) return normalizedColor;
  if (isRgbInGamut(oklchToRgbUnchecked(normalizedColor))) return normalizedColor;

  let low = 0;
  let high = normalizedColor.c;
  let best = { ...normalizedColor, c: 0 };

  for (let i = 0; i < 28; i += 1) {
    const mid = (low + high) / 2;
    const candidate = { ...normalizedColor, c: mid };
    if (isRgbInGamut(oklchToRgbUnchecked(candidate))) {
      best = candidate;
      low = mid;
    } else {
      high = mid;
    }
  }

  return best;
}

function oklchToRgb(color: OklchColor): RgbColor {
  const clamped = clampOklchToGamut(color);
  const rgb = oklchToRgbUnchecked(clamped);
  return {
    r: clamp(rgb.r, 0, 1),
    g: clamp(rgb.g, 0, 1),
    b: clamp(rgb.b, 0, 1),
  };
}

function oklchToHex(color: OklchColor): string {
  return rgbToHex(oklchToRgb(color));
}

function toCssOklch(color: OklchColor): string {
  const clamped = clampOklchToGamut(color);
  return `oklch(${round(clamped.l * 100, 2)}% ${round(clamped.c, 4)} ${round(clamped.h, 2)})`;
}

function toCssRgba(color: OklchColor, alpha: number): string {
  const rgb = oklchToRgb(color);
  return `rgba(${Math.round(rgb.r * 255)}, ${Math.round(rgb.g * 255)}, ${Math.round(rgb.b * 255)}, ${round(alpha, 3)})`;
}

function mixHue(sourceHue: number, targetHue: number, amount: number): number {
  const delta = ((targetHue - sourceHue + 540) % 360) - 180;
  return normalizeHue(sourceHue + delta * amount);
}

function mixOklch(source: OklchColor, target: OklchColor, amount: number): OklchColor {
  const t = clamp(amount, 0, 1);
  const sourceHue = source.c < 0.0001 ? target.h : source.h;
  const targetHue = target.c < 0.0001 ? source.h : target.h;
  return clampOklchToGamut({
    l: source.l + (target.l - source.l) * t,
    c: source.c + (target.c - source.c) * t,
    h: mixHue(sourceHue, targetHue, t),
  });
}

function shiftHue(color: OklchColor, delta: number): OklchColor {
  return { ...color, h: normalizeHue(color.h + delta) };
}

function getRelativeLuminance(rgb: RgbColor): number {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getContrastRatio(foreground: OklchColor, background: OklchColor): number {
  const foregroundLuminance = getRelativeLuminance(oklchToRgb(foreground));
  const backgroundLuminance = getRelativeLuminance(oklchToRgb(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function getReadableTextColor(background: OklchColor): string {
  const whiteContrast = getContrastRatio(WHITE_OKLCH, background);
  const blackContrast = getContrastRatio(BLACK_OKLCH, background);
  return whiteContrast >= blackContrast ? WHITE_TEXT : BLACK_TEXT;
}

function ensureContrast(
  foreground: OklchColor,
  background: OklchColor,
  targetRatio: number,
  direction: ContrastDirection,
): OklchColor {
  const initial = clampOklchToGamut(foreground);
  if (getContrastRatio(initial, background) >= targetRatio) return initial;

  let low = direction === "lighter" ? initial.l : 0;
  let high = direction === "lighter" ? 1 : initial.l;
  let resolved = initial;

  for (let i = 0; i < 30; i += 1) {
    const mid = (low + high) / 2;
    const candidate = clampOklchToGamut({ ...initial, l: mid });
    const passes = getContrastRatio(candidate, background) >= targetRatio;

    if (passes) {
      resolved = candidate;
      if (direction === "lighter") high = mid;
      else low = mid;
    } else if (direction === "lighter") {
      low = mid;
    } else {
      high = mid;
    }
  }

  return resolved;
}

function ensureAutoContrast(foreground: OklchColor, background: OklchColor, targetRatio: number): OklchColor {
  const direction: ContrastDirection = background.l < 0.52 ? "lighter" : "darker";
  return ensureContrast(foreground, background, targetRatio, direction);
}

function normalizeInputColor(rawColor: string | null | undefined, fallback: OklchColor): OklchColor {
  const parsed = parseHexColor(rawColor);
  if (!parsed) return fallback;
  return rgbToOklch(parsed);
}

function normalizeThemeHsl(color: HslColor, mode: ProfileThemeMode, role: "primary" | "accent"): HslColor {
  const normalized = normalizeHsl(color);
  const isNeutral = normalized.s <= 6;

  return {
    h: isNeutral ? 0 : normalized.h,
    s: clamp(isNeutral ? 0 : normalized.s, role === "primary" ? 0 : 8, 84),
    l: clamp(
      normalized.l,
      mode === "dark" ? (role === "primary" ? 14 : 18) : 22,
      mode === "dark" ? 82 : 88,
    ),
  };
}

export function adjustPrimaryForDarkExtremes(
  primaryHsl: HslColor,
  target: "banner" | "body" = "body",
): HslColor {
  const normalized = normalizeHsl(primaryHsl);
  const isNearNeutral = isNearNeutralHsl(normalized, 12);

  if (relativeLuminance(hslToRgb(normalized)) >= 0.08) {
    return normalized;
  }

  return normalizeHsl({
    h: isNearNeutral ? 0 : normalized.h,
    s: isNearNeutral ? 0 : clamp(normalized.s * 0.75, 10, 60),
    l: target === "banner" ? clamp(normalized.l + 4, 10, 18) : clamp(normalized.l + 12, 18, 28),
  });
}

function adjustPrimaryForLightExtremes(
  primaryHsl: HslColor,
  target: "banner" | "body" = "body",
): HslColor {
  const normalized = normalizeHsl(primaryHsl);
  const isNearNeutral = isNearNeutralHsl(normalized, 10);

  if (relativeLuminance(hslToRgb(normalized)) <= 0.92) {
    return normalized;
  }

  return normalizeHsl({
    h: isNearNeutral ? 0 : normalized.h,
    s: isNearNeutral ? 0 : clamp(normalized.s * 0.35, 4, 18),
    l: target === "banner" ? 94 : 82,
  });
}

function normalizePrimaryThemeColor(color: HslColor, mode: ProfileThemeMode): HslColor {
  let next = normalizeThemeHsl(color, mode, "primary");
  const luminance = relativeLuminance(hslToRgb(next));

  if (luminance < 0.08) next = adjustPrimaryForDarkExtremes(next, "body");
  if (luminance > 0.92) next = adjustPrimaryForLightExtremes(next, "body");
  return next;
}

export function deriveBodyBaseColor(primaryHsl: HslColor, mode: ProfileThemeMode = "dark"): HslColor {
  const normalizedPrimary = normalizePrimaryThemeColor(primaryHsl, mode);
  const isNearNeutral = isNearNeutralHsl(normalizedPrimary, 12);

  if (mode === "dark") {
    return normalizeHsl({
      h: isNearNeutral ? 0 : normalizedPrimary.h,
      s: isNearNeutral ? 0 : clamp(normalizedPrimary.s * 0.22, 4, 18),
      l: clamp(normalizedPrimary.l * 0.52, 22, 36),
    });
  }

  return normalizeHsl({
    h: isNearNeutral ? 0 : normalizedPrimary.h,
    s: isNearNeutral ? 0 : clamp(normalizedPrimary.s * 0.18, 0, 14),
    l: clamp(88 - (100 - normalizedPrimary.l) * 0.12, 76, 92),
  });
}

export function deriveAccent(primaryHsl: HslColor, accentHsl?: HslColor | null): HslColor {
  const primary = normalizeHsl(primaryHsl);
  const accent = accentHsl ? normalizeHsl(accentHsl) : null;

  if (accent && (hueDistance(primary.h, accent.h) > 6 || Math.abs(primary.s - accent.s) > 6 || Math.abs(primary.l - accent.l) > 6)) {
    return accent;
  }

  return normalizeHsl({
    h: primary.s <= 10 ? primary.h + 14 : primary.h + 8,
    s: clamp(primary.s + 12, 16, 84),
    l: clamp(primary.l + (primary.l < 48 ? 8 : -6), 18, 82),
  });
}

function pickReadableText(background: Rgb255Color): Rgb255Color {
  const softLight: Rgb255Color = { r: 245, g: 247, b: 250 };
  const softDark: Rgb255Color = { r: 18, g: 22, b: 27 };

  const whiteContrast = contrastRatio(softLight, background);
  const darkContrast = contrastRatio(softDark, background);

  return whiteContrast >= darkContrast ? softLight : softDark;
}

function ensureMutedContrast(text: Rgb255Color, background: Rgb255Color): Rgb255Color {
  let amount = 0.72;
  let muted = mixColors(background, text, amount);

  while (contrastRatio(muted, background) < 4.5 && amount < 0.96) {
    amount += 0.04;
    muted = mixColors(background, text, amount);
  }

  return muted;
}

function ensureContainerContrast(color: HslColor, background: Rgb255Color, mode: ProfileThemeMode, target = 3): HslColor {
  let next = normalizeHsl(color);

  for (let step = 0; step < 28; step += 1) {
    if (contrastRatio(hslToRgb(next), background) >= target) return next;
    next = adjustLightness(next, mode === "dark" ? 2 : -2);
    if (step % 4 === 3) next = adjustSaturation(next, 2);
  }

  return next;
}

function buildProfileBackgroundOverlay(mode: ProfileThemeMode, overlayAlpha: number): string {
  if (overlayAlpha <= 0) return "none";

  if (mode === "light") {
    return `linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(0,0,0,${round(overlayAlpha, 3)}) 100%)`;
  }

  return `linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(0,0,0,${round(overlayAlpha, 3)}) 100%)`;
}

function buildLayeredCardBackground(bannerHex: string, bodyHex: string, accent: Rgb255Color): string {
  const a = normalizeRgb255(accent);
  return [
    `linear-gradient(180deg, rgba(${a.r}, ${a.g}, ${a.b}, 0.18) 0%, rgba(${a.r}, ${a.g}, ${a.b}, 0.08) 35%, rgba(${a.r}, ${a.g}, ${a.b}, 0.02) 55%, rgba(${a.r}, ${a.g}, ${a.b}, 0) 70%)`,
    `linear-gradient(180deg, ${bannerHex} 0%, ${bodyHex} 100%)`,
  ].join(", ");
}

function buildVerticalGradient(topColor: string, bottomColor: string): string {
  return `linear-gradient(180deg, ${topColor} 0%, ${topColor} 24%, ${bottomColor} 100%)`;
}

function buildShellBorderGradient(primary: string, accent: string): string {
  const top = parseHex(primary) ?? { r: 255, g: 255, b: 255 };
  const bottom = parseHex(accent) ?? top;
  const midUpper = rgb255ToHex(mixColors(top, bottom, 0.28));
  const midLower = rgb255ToHex(mixColors(top, bottom, 0.62));

  return `linear-gradient(180deg, ${primary} 0%, ${primary} 16%, ${midUpper} 46%, ${midLower} 76%, ${accent} 100%)`;
}

function buildBadgeGradient(from: OklchColor, to: OklchColor): string {
  return `linear-gradient(145deg, ${toCssOklch(from)}, ${toCssOklch(to)})`;
}

function shouldUseGraphiteMode(primary: OklchColor, accent: OklchColor, primaryRaw: string, accentRaw: string): boolean {
  const primaryHex = normalizeBannerColor(primaryRaw);
  const accentHex = normalizeBannerColor(accentRaw);

  const isBlackWhitePair =
    (primaryHex === "#000000" && accentHex === "#ffffff") ||
    (primaryHex === "#ffffff" && accentHex === "#000000");

  return isBlackWhitePair || (primary.c <= 0.02 && accent.c <= 0.025);
}

export function generateSurfaces(baseDark: string | OklchColor, mode: ProfileThemeMode = "dark"): ProfileSurfaceScale {
  const baseColor = typeof baseDark === "string" ? normalizeInputColor(baseDark, DEFAULT_PRIMARY) : baseDark;
  const modalBg = clampOklchToGamut(baseColor);
  const target = mode === "dark" ? WHITE_OKLCH : BLACK_OKLCH;

  const surface = mixOklch(modalBg, target, 0.05);
  const surface2 = mixOklch(modalBg, target, 0.1);
  const surface3 = mixOklch(modalBg, target, 0.15);

  return {
    modalBg: toCssOklch(modalBg),
    surface: toCssOklch(surface),
    surface2: toCssOklch(surface2),
    surface3: toCssOklch(surface3),
    raw: {
      modalBg,
      surface,
      surface2,
      surface3,
    },
  };
}

export function normalizeUserColor(hex: string): string {
  const input = normalizeInputColor(hex, DEFAULT_PRIMARY);
  const rawHex = normalizeBannerColor(hex);
  const isPureWhite = rawHex === "#ffffff";
  const isPureBlack = rawHex === "#000000";
  const isNearNeutral = input.c < 0.02;

  const normalized = clampOklchToGamut({
    l: clamp(isPureWhite ? 0.98 : isPureBlack ? 0.092 : input.l, 0.092, isNearNeutral ? 0.98 : 0.82),
    c: isNearNeutral ? clamp(input.c, 0, 0.02) : clamp(input.c, 0.032, 0.22),
    h: normalizeHue(input.h),
  });

  return oklchToHex(normalized);
}

function getDefaultProfileThemeHex(mode: ProfileThemeMode): string {
  return mode === "light" ? "#8695ab" : "#5b6678";
}

function resolveThemeInputHex(rawColor: string | null | undefined, fallbackHex: string): string {
  return normalizeBannerColor(rawColor) ?? fallbackHex;
}

export function buildProfileTheme(
  primaryHex: string,
  accentHex: string | null | undefined,
  mode: ProfileThemeMode,
): BuiltProfileTheme {
  const resolvedMode = mode === "light" ? "light" : "dark";

  const fallbackPrimaryHex = getDefaultProfileThemeHex(resolvedMode);
  const resolvedPrimaryHex = resolveThemeInputHex(primaryHex, fallbackPrimaryHex);
  const shouldPreservePrimaryExtreme =
    resolvedPrimaryHex === "#ffffff" || resolvedPrimaryHex === "#000000";
  const primaryRgb = parseHex(resolvedPrimaryHex) ?? parseHex(fallbackPrimaryHex)!;

  const fallbackAccentHex = rgb255ToHex(primaryRgb);
  const resolvedAccentHex = resolveThemeInputHex(accentHex, fallbackAccentHex);
  const accentRgbInput = parseHex(resolvedAccentHex) ?? primaryRgb;

  const rawPrimaryHsl = rgbToHsl(primaryRgb);
  const rawAccentHsl = rgbToHsl(accentRgbInput);

  const primaryHsl = normalizePrimaryThemeColor(rawPrimaryHsl, resolvedMode);
  const accentHsl = normalizeThemeHsl(deriveAccent(primaryHsl, rawAccentHsl), resolvedMode, "accent");

  const bannerRgb = hslToRgb(
    relativeLuminance(hslToRgb(primaryHsl)) < 0.08
      ? adjustPrimaryForDarkExtremes(primaryHsl, "banner")
      : relativeLuminance(hslToRgb(primaryHsl)) > 0.92
        ? adjustPrimaryForLightExtremes(primaryHsl, "banner")
        : primaryHsl,
  );

  const finalPrimaryHex = shouldPreservePrimaryExtreme ? resolvedPrimaryHex : rgb255ToHex(bannerRgb);
  const finalAccentRgb = hslToRgb(accentHsl);
  const finalAccentHex = rgb255ToHex(finalAccentRgb);

  const primaryOklch = normalizeInputColor(finalPrimaryHex, DEFAULT_PRIMARY);
  const accentOklch = normalizeInputColor(finalAccentHex, DEFAULT_ACCENT);

  const isGraphiteMode = shouldUseGraphiteMode(primaryOklch, accentOklch, finalPrimaryHex, finalAccentHex);

  const isPureMonoDark = finalPrimaryHex === "#000000" && finalAccentHex === "#000000";
  const isPureMonoLight = finalPrimaryHex === "#ffffff" && finalAccentHex === "#ffffff";

  if (isPureMonoDark || isPureMonoLight) {
    const isDark = isPureMonoDark;
    const pureHex = isDark ? "#000000" : "#ffffff";
    const sep = isDark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
    const text = isDark ? { r: 245, g: 247, b: 250 } : { r: 18, g: 22, b: 27 };
    const muted = isDark ? { r: 159, g: 159, b: 159 } : { r: 86, g: 86, b: 86 };

    return {
      mode: resolvedMode,
      primaryHex: pureHex,
      accentHex: pureHex,
      bodyBaseHex: pureHex,
      bodyBgHex: pureHex,
      bodyGlow: "rgba(0,0,0,0)",
      overlayAlpha: 0,
      textHex: rgb255ToHex(text),
      mutedHex: rgb255ToHex(muted),
      borderColor: toRgbaString(sep, 0.08),
      borderTopColor: toRgbaString(sep, 0.1),
      dividerColor: toRgbaString(sep, 0.08),
      buttonBgHex: "#575757",
      buttonHoverHex: "#4b4b4b",
      buttonActiveHex: "#3f3f3f",
      buttonTextHex: "#f5f7fa",
      linkHex: isDark ? "#f5f7fa" : "#12161b",
      focusRing: isDark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.16)",
      shellBgHex: pureHex,
      isGraphiteMode: true,
      variables: {
        "--profile-primary": pureHex,
        "--profile-accent": pureHex,
        "--profile-banner-bg": pureHex,
        "--profile-body-base": pureHex,
        "--profile-body-sheen": "rgba(0,0,0,0)",
        "--profile-body-depth": "rgba(0,0,0,0)",
        "--profile-glow": "rgba(0,0,0,0)",
        "--profile-separator": toRgbaString(sep, 0.1),
        "--profile-card-bg": pureHex,
        "--profile-body-bg": pureHex,
        "--profile-body-glow": "rgba(0,0,0,0)",
        "--profile-border-top": toRgbaString(sep, 0.1),
        "--profile-overlay-alpha": "0",
        "--profile-bg": pureHex,
        "--profile-bg-overlay": "none",
        "--profile-text": rgb255ToHex(text),
        "--profile-muted": rgb255ToHex(muted),
        "--profile-button-bg": "#575757",
        "--profile-button-bg-hover": "#4b4b4b",
        "--profile-button-bg-active": "#3f3f3f",
        "--profile-button-text": "#f5f7fa",
      },
    };
  }

  const bodyBaseHsl = deriveBodyBaseColor(primaryHsl, resolvedMode);
  const bodyBaseRgb = hslToRgb(bodyBaseHsl);
  const bodyBaseHex = rgb255ToHex(bodyBaseRgb);

  const textRgbBase = pickReadableText(bodyBaseRgb);
  const mutedRgbBase = ensureMutedContrast(textRgbBase, bodyBaseRgb);

  const bodyRole = normalizeInputColor(bodyBaseHex, DEFAULT_PRIMARY);
  const primaryRole = normalizeInputColor(finalPrimaryHex, DEFAULT_PRIMARY);
  const accentRole = normalizeInputColor(finalAccentHex, DEFAULT_ACCENT);

  const surfaceRole = mixOklch(bodyRole, resolvedMode === "dark" ? WHITE_OKLCH : BLACK_OKLCH, 0.06);
  const surfaceRaisedRole = mixOklch(bodyRole, resolvedMode === "dark" ? WHITE_OKLCH : BLACK_OKLCH, 0.1);

  const separatorRgb = unitRgbTo255(oklchToRgb(surfaceRaisedRole));
  const borderRgb = unitRgbTo255(oklchToRgb(surfaceRole));

  const glowRole = mixOklch(accentRole, bodyRole, 0.8);
  const glowRgb = unitRgbTo255(oklchToRgb(glowRole));
  const glowOpacity = clamp(0.08 + accentRole.c * 0.16, 0.08, 0.14);

  const buttonBgHsl = ensureContainerContrast(
    rgbToHsl(unitRgbTo255(oklchToRgb(accentRole))),
    bodyBaseRgb,
    resolvedMode,
    3,
  );

  const buttonHoverHsl = ensureContainerContrast(
    rgbToHsl(unitRgbTo255(oklchToRgb(mixOklch(accentRole, BLACK_OKLCH, 0.16)))),
    bodyBaseRgb,
    resolvedMode,
    3,
  );

  const buttonActiveHsl = ensureContainerContrast(
    rgbToHsl(unitRgbTo255(oklchToRgb(mixOklch(accentRole, BLACK_OKLCH, 0.28)))),
    bodyBaseRgb,
    resolvedMode,
    3,
  );

  const buttonBgRgb = hslToRgb(buttonBgHsl);
  const buttonTextRgb = pickReadableText(buttonBgRgb);

  const linkRole = ensureAutoContrast(accentRole, bodyRole, 4.5);
  const linkHex = rgbToHex(oklchToRgb(linkRole));

  const focusRingRole = ensureAutoContrast(mixOklch(accentRole, WHITE_OKLCH, 0.28), bodyRole, 3);
  const focusRingRgb = unitRgbTo255(oklchToRgb(focusRingRole));

  const overlayAlpha = resolvedMode === "dark" ? 0.06 : 0;
  const bodyGlow = toRgbaString(glowRgb, glowOpacity);

  const cardBackground = buildLayeredCardBackground(finalPrimaryHex, bodyBaseHex, finalAccentRgb);

  return {
    mode: resolvedMode,
    primaryHex: finalPrimaryHex,
    accentHex: finalAccentHex,
    bodyBaseHex,
    bodyBgHex: bodyBaseHex,
    bodyGlow,
    overlayAlpha,
    textHex: rgb255ToHex(textRgbBase),
    mutedHex: rgb255ToHex(mutedRgbBase),
    borderColor: toRgbaString(borderRgb, resolvedMode === "dark" ? 0.5 : 0.28),
    borderTopColor: toRgbaString(separatorRgb, resolvedMode === "dark" ? 0.34 : 0.24),
    dividerColor: toRgbaString(separatorRgb, resolvedMode === "dark" ? 0.24 : 0.16),
    buttonBgHex: rgb255ToHex(hslToRgb(buttonBgHsl)),
    buttonHoverHex: rgb255ToHex(hslToRgb(buttonHoverHsl)),
    buttonActiveHex: rgb255ToHex(hslToRgb(buttonActiveHsl)),
    buttonTextHex: rgb255ToHex(buttonTextRgb),
    linkHex,
    focusRing: toRgbaString(focusRingRgb, resolvedMode === "dark" ? 0.42 : 0.28),
    shellBgHex: bodyBaseHex,
    isGraphiteMode,
    variables: {
      "--profile-primary": finalPrimaryHex,
      "--profile-accent": finalAccentHex,
      "--profile-banner-bg": finalPrimaryHex,
      "--profile-body-base": bodyBaseHex,
      "--profile-body-sheen": toRgbaString(mixColors(bodyBaseRgb, finalAccentRgb, 0.18), resolvedMode === "dark" ? 0.1 : 0.08),
      "--profile-body-depth": toRgbaString(mixColors(bodyBaseRgb, { r: 0, g: 0, b: 0 }, resolvedMode === "dark" ? 0.18 : 0.1), resolvedMode === "dark" ? 0.1 : 0.08),
      "--profile-glow": bodyGlow,
      "--profile-separator": toRgbaString(separatorRgb, resolvedMode === "dark" ? 0.34 : 0.24),
      "--profile-card-bg": cardBackground,
      "--profile-body-bg": bodyBaseHex,
      "--profile-body-glow": bodyGlow,
      "--profile-border-top": toRgbaString(separatorRgb, resolvedMode === "dark" ? 0.34 : 0.24),
      "--profile-overlay-alpha": String(round(overlayAlpha, 3)),
      "--profile-bg": bodyBaseHex,
      "--profile-bg-overlay": buildProfileBackgroundOverlay(resolvedMode, overlayAlpha),
      "--profile-text": rgb255ToHex(textRgbBase),
      "--profile-muted": rgb255ToHex(mutedRgbBase),
      "--profile-button-bg": rgb255ToHex(hslToRgb(buttonBgHsl)),
      "--profile-button-bg-hover": rgb255ToHex(hslToRgb(buttonHoverHsl)),
      "--profile-button-bg-active": rgb255ToHex(hslToRgb(buttonActiveHsl)),
      "--profile-button-text": rgb255ToHex(buttonTextRgb),
    },
  };
}

function createThemeStyle(tokens: ProfileThemeTokens): ProfileThemeInlineStyle {
  const style: ProfileThemeInlineStyle = {};
  (Object.keys(tokens) as ProfileThemeTokenName[]).forEach((tokenName) => {
    style[tokenName] = tokens[tokenName];
  });
  return style;
}

export function createProfileTheme({
  primaryColor,
  accentColor,
  mode,
}: CreateProfileThemeInput): ProfileTheme {
  const builtTheme = buildProfileTheme(primaryColor, accentColor, mode);

  const isPureMonoDarkTheme =
    builtTheme.primaryHex === "#000000" &&
    builtTheme.accentHex === "#000000" &&
    builtTheme.bodyBgHex === "#000000";

  const isPureMonoLightTheme =
    builtTheme.primaryHex === "#ffffff" &&
    builtTheme.accentHex === "#ffffff" &&
    builtTheme.bodyBgHex === "#ffffff";

  const isPureMonoTheme = isPureMonoDarkTheme || isPureMonoLightTheme;

  const normalizedPrimary = builtTheme.primaryHex;
  const normalizedAccent = builtTheme.accentHex;

  const primaryOklch = normalizeInputColor(normalizedPrimary, DEFAULT_PRIMARY);
  const accentOklch = normalizeInputColor(normalizedAccent, DEFAULT_ACCENT);

  const isGraphiteMode = builtTheme.isGraphiteMode;

  const surfaces = isPureMonoDarkTheme
    ? {
        modalBg: "#000000",
        surface: "#000000",
        surface2: "#000000",
        surface3: "#000000",
        raw: {
          modalBg: BLACK_OKLCH,
          surface: BLACK_OKLCH,
          surface2: BLACK_OKLCH,
          surface3: BLACK_OKLCH,
        },
      }
    : isPureMonoLightTheme
      ? {
          modalBg: "#ffffff",
          surface: "#ffffff",
          surface2: "#ffffff",
          surface3: "#ffffff",
          raw: {
            modalBg: WHITE_OKLCH,
            surface: WHITE_OKLCH,
            surface2: WHITE_OKLCH,
            surface3: WHITE_OKLCH,
          },
        }
      : generateSurfaces(builtTheme.bodyBgHex, mode);

  const surfaceBase = surfaces.raw.surface;
  const surfaceRaised = surfaces.raw.surface2;
  const surfaceHighest = surfaces.raw.surface3;
  const bodyRole = normalizeInputColor(builtTheme.bodyBgHex, DEFAULT_PRIMARY);

  const textColor = normalizeInputColor(builtTheme.textHex, mode === "dark" ? WHITE_OKLCH : BLACK_OKLCH);
  const mutedText = normalizeInputColor(builtTheme.mutedHex, textColor);
  const accentStrong = normalizeInputColor(builtTheme.buttonBgHex, accentOklch);
  const accentLink = normalizeInputColor(builtTheme.linkHex, accentStrong);

  const accessibleText = ensureAutoContrast(textColor, surfaceBase, 4.5);
  const accessibleMuted = ensureAutoContrast(mutedText, surfaceBase, 4.5);
  const accessibleLink = ensureAutoContrast(accentLink, surfaceBase, 4.5);

  const accessibleTextHex = rgbToHex(oklchToRgb(accessibleText));
  const accessibleMutedHex = rgbToHex(oklchToRgb(accessibleMuted));
  const accessibleLinkHex = rgbToHex(oklchToRgb(accessibleLink));

  const accentSoftBase = mixOklch(accentStrong, bodyRole, 0.8);
  const onAccent = builtTheme.buttonTextHex;

  const shadowSmBase = mixOklch(bodyRole, BLACK_OKLCH, 0.75);
  const shadowMdBase = mixOklch(bodyRole, BLACK_OKLCH, 0.82);

  const hoverSurface = mixOklch(surfaceBase, accentStrong, 0.1);
  const inputSurface = mixOklch(surfaceBase, surfaceHighest, 0.18);

  const positiveColor = clampOklchToGamut({ l: 0.76, c: 0.15, h: 152 });
  const positiveSoft = mixOklch(positiveColor, surfaceBase, 0.68);

  const idleColor = clampOklchToGamut({ l: 0.74, c: 0.11, h: 82 });
  const dangerColor = clampOklchToGamut({ l: 0.68, c: 0.15, h: 22 });
  const invisibleColor = clampOklchToGamut({ l: 0.67, c: 0.03, h: DEFAULT_GRAPHITE_HUE });

  const badgeBase = clampOklchToGamut({
    l: clamp(accentStrong.l + 0.06, 0, 0.88),
    c: clamp(accentStrong.c + 0.03, 0.03, 0.19),
    h: accentStrong.h,
  });

  const badgeGradient1 = buildBadgeGradient(
    shiftHue(badgeBase, -14),
    shiftHue({ ...badgeBase, l: clamp(badgeBase.l - 0.1, 0, 1) }, 16),
  );

  const badgeGradient2 = buildBadgeGradient(
    shiftHue({ ...badgeBase, l: clamp(badgeBase.l + 0.03, 0, 1) }, 10),
    shiftHue({ ...badgeBase, l: clamp(badgeBase.l - 0.06, 0, 1) }, 36),
  );

  const badgeGradient3 = buildBadgeGradient(
    shiftHue({ ...badgeBase, l: clamp(badgeBase.l + 0.02, 0, 1) }, -28),
    shiftHue({ ...badgeBase, l: clamp(badgeBase.l - 0.08, 0, 1) }, 52),
  );

  const shellBorderGradient = isPureMonoTheme
    ? buildVerticalGradient(builtTheme.primaryHex, builtTheme.accentHex)
    : buildShellBorderGradient(builtTheme.primaryHex, builtTheme.accentHex);

  const tokens: ProfileThemeTokens = {
    "--profile-primary": builtTheme.variables["--profile-primary"],
    "--profile-banner-bg": builtTheme.variables["--profile-banner-bg"],
    "--profile-body-base": builtTheme.variables["--profile-body-base"],
    "--profile-body-sheen": builtTheme.variables["--profile-body-sheen"],
    "--profile-body-depth": builtTheme.variables["--profile-body-depth"],
    "--profile-glow": builtTheme.variables["--profile-glow"],
    "--profile-separator": builtTheme.variables["--profile-separator"],
    "--profile-card-bg": builtTheme.variables["--profile-card-bg"],
    "--profile-body-bg": builtTheme.variables["--profile-body-bg"],
    "--profile-body-glow": builtTheme.variables["--profile-body-glow"],
    "--profile-border-top": builtTheme.variables["--profile-border-top"],
    "--profile-overlay-alpha": builtTheme.variables["--profile-overlay-alpha"],
    "--profile-modal-bg": surfaces.modalBg,
    "--profile-shell-bg": builtTheme.shellBgHex,
    "--profile-shell-border-gradient": shellBorderGradient,
    "--profile-bg": builtTheme.variables["--profile-bg"],
    "--profile-bg-overlay": builtTheme.variables["--profile-bg-overlay"],
    "--profile-surface": surfaces.surface,
    "--profile-surface-2": surfaces.surface2,
    "--profile-surface-3": surfaces.surface3,
    "--profile-border": builtTheme.borderColor,
    "--profile-divider": builtTheme.dividerColor,
    "--profile-text": accessibleTextHex,
    "--profile-muted": accessibleMutedHex,
    "--profile-text-muted": accessibleMutedHex,
    "--profile-accent": builtTheme.variables["--profile-accent"],
    "--profile-accent-soft": toCssRgba(accentSoftBase, 0.22),
    "--profile-accent-strong": builtTheme.buttonBgHex,
    "--profile-button-bg": builtTheme.buttonBgHex,
    "--profile-button-bg-hover": builtTheme.buttonHoverHex,
    "--profile-button-bg-active": builtTheme.buttonActiveHex,
    "--profile-button-text": builtTheme.buttonTextHex,
    "--profile-focus-ring": builtTheme.focusRing,
    "--profile-shadow-sm": isPureMonoDarkTheme
      ? "0 10px 24px rgba(0, 0, 0, 0.28)"
      : isPureMonoLightTheme
        ? "0 10px 24px rgba(0, 0, 0, 0.12)"
        : `0 10px 24px ${toCssRgba(shadowSmBase, 0.28)}`,
    "--profile-shadow-md": isPureMonoDarkTheme
      ? "0 8px 20px rgba(0,0,0,0.25), 0 2px 6px rgba(0,0,0,0.18)"
      : isPureMonoLightTheme
        ? "0 8px 20px rgba(0,0,0,0.14), 0 2px 6px rgba(0,0,0,0.08)"
        : "0 8px 20px rgba(0,0,0,0.25), 0 2px 6px rgba(0,0,0,0.18)",
    "--profile-on-accent": onAccent,
    "--profile-link": accessibleLinkHex,
    "--profile-link-hover": rgb255ToHex(
      mixColors(
        parseHex(accessibleLinkHex) ?? { r: 255, g: 255, b: 255 },
        parseHex(accessibleTextHex) ?? { r: 255, g: 255, b: 255 },
        0.12,
      ),
    ),
    "--profile-hover-surface": toCssRgba(hoverSurface, 0.92),
    "--profile-input-bg": toCssRgba(inputSurface, mode === "dark" ? 0.78 : 0.66),
    "--profile-overlay": `rgba(0, 0, 0, ${round(builtTheme.overlayAlpha, 3)})`,
    "--profile-overlay-hover": `rgba(0, 0, 0, ${round(clamp(builtTheme.overlayAlpha + 0.08, 0, 0.4), 3)})`,
    "--profile-menu-surface": toCssOklch(mixOklch(surfaceHighest, surfaceBase, 0.15)),
    "--profile-menu-shadow": `0 16px 34px ${toCssRgba(shadowMdBase, 0.46)}`,
    "--profile-danger": toCssOklch(dangerColor),
    "--profile-danger-soft": toCssRgba(mixOklch(dangerColor, surfaceBase, 0.74), 0.28),
    "--profile-danger-text": toCssOklch(ensureAutoContrast(dangerColor, surfaceBase, 4.5)),
    "--profile-positive": toCssOklch(positiveColor),
    "--profile-positive-soft": toCssRgba(positiveSoft, 0.28),
    "--profile-spotify-progress": toCssOklch(clampOklchToGamut({ l: 0.76, c: 0.18, h: 148 })),
    "--profile-selection": toCssRgba(accentLink, 0.32),
    "--profile-scrollbar-thumb": "linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0.08))",
    "--profile-scrollbar-thumb-hover": "linear-gradient(180deg, rgba(255,255,255,0.24), rgba(255,255,255,0.12))",
    "--profile-presence-online": toCssOklch(positiveColor),
    "--profile-presence-idle": toCssOklch(idleColor),
    "--profile-presence-dnd": toCssOklch(dangerColor),
    "--profile-presence-invisible": toCssOklch(invisibleColor),
    "--profile-badge-gradient-1": badgeGradient1,
    "--profile-badge-gradient-2": badgeGradient2,
    "--profile-badge-gradient-3": badgeGradient3,
    "--profile-transition-fast": "160ms cubic-bezier(0.22, 1, 0.36, 1)",
    "--profile-transition-standard": "180ms cubic-bezier(0.22, 1, 0.36, 1)",
  };

  return {
    mode,
    isGraphiteMode,
    normalizedPrimary,
    normalizedAccent,
    bannerColor: normalizedPrimary,
    surfaces,
    tokens,
    style: createThemeStyle(tokens),
  };
}
