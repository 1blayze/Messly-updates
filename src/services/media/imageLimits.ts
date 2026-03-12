export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const BANNER_MAX_BYTES = 5 * 1024 * 1024;

export const AVATAR_ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const BANNER_ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const AVATAR_MAX_MB = Math.round(AVATAR_MAX_BYTES / (1024 * 1024));
export const BANNER_MAX_MB = Math.round(BANNER_MAX_BYTES / (1024 * 1024));
