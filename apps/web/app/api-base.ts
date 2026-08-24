const configuredApiBase = process.env.NEXT_PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "") ?? "";

const legacyLocalApiPattern = /^http:\/\/(?:localhost|127\.0\.0\.1):3001$/i;

export const API_BASE = legacyLocalApiPattern.test(configuredApiBase) ? "" : configuredApiBase;
