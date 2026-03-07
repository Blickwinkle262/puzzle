function isTrueValue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isFalseValue(value) {
  return ["0", "false", "no", "off"].includes(String(value || "").trim().toLowerCase());
}

function resolveNodeEnv(env) {
  return String(env.NODE_ENV || "").trim().toLowerCase();
}

export function resolveSessionTtlMs(env = process.env) {
  const defaultMs = 1000 * 60 * 60 * 24 * 30;
  const rawDays = env.SESSION_TTL_DAYS;

  if (rawDays === undefined || rawDays === null || rawDays === "") {
    return defaultMs;
  }

  const days = Number(rawDays);
  if (!Number.isFinite(days) || days <= 0) {
    return defaultMs;
  }

  return Math.max(60_000, Math.floor(days * 24 * 60 * 60 * 1000));
}

export function resolveCookieSecure(env = process.env) {
  const rawValue = env.COOKIE_SECURE;

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return resolveNodeEnv(env) === "production";
  }

  return isTrueValue(rawValue);
}

export function resolveCookieSameSite(cookieSecure, env = process.env) {
  const normalized = String(env.COOKIE_SAME_SITE || "Lax").trim().toLowerCase();

  if (normalized === "strict") {
    return "Strict";
  }

  if (normalized === "none") {
    return cookieSecure ? "None" : "Lax";
  }

  return "Lax";
}

export function resolveTrustProxySetting(env = process.env) {
  const rawValue = env.TRUST_PROXY;

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return false;
  }

  if (isTrueValue(rawValue)) {
    return true;
  }

  if (isFalseValue(rawValue)) {
    return false;
  }

  return rawValue;
}

export function resolvePublicRegistrationEnabled(env = process.env) {
  const rawValue = env.PUBLIC_REGISTRATION_ENABLED;

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return resolveNodeEnv(env) !== "production";
  }

  if (isTrueValue(rawValue)) {
    return true;
  }

  if (isFalseValue(rawValue)) {
    return false;
  }

  return false;
}

export function resolveAdminUsernameFallbackEnabled(env = process.env) {
  const rawValue = env.ADMIN_USERNAME_FALLBACK_ENABLED;

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return resolveNodeEnv(env) !== "production";
  }

  if (isTrueValue(rawValue)) {
    return true;
  }

  if (isFalseValue(rawValue)) {
    return false;
  }

  return false;
}

export function assertProductionWorkerToken(token, env = process.env) {
  if (resolveNodeEnv(env) !== "production") {
    return;
  }

  const value = String(token || "").trim();
  if (!value || value === "change-me" || value === "dev-worker-token" || value.length < 32) {
    throw new Error(
      "STORY_GENERATOR_WORKER_TOKEN is missing or too weak for production; configure a random token with at least 32 chars.",
    );
  }
}

export function assertProductionRegistrationSafety(options = {}, env = process.env) {
  if (resolveNodeEnv(env) !== "production") {
    return;
  }

  const publicRegistrationEnabled = Boolean(options.publicRegistrationEnabled);
  const adminUsernameFallbackEnabled = Boolean(options.adminUsernameFallbackEnabled);
  const adminUsernames = options.adminUsernames instanceof Set
    ? options.adminUsernames
    : new Set(Array.isArray(options.adminUsernames) ? options.adminUsernames : []);

  if (publicRegistrationEnabled && adminUsernameFallbackEnabled && adminUsernames.size > 0) {
    throw new Error(
      "Unsafe auth config in production: PUBLIC_REGISTRATION_ENABLED and ADMIN_USERNAME_FALLBACK_ENABLED cannot both be true when ADMIN_USERNAMES is configured.",
    );
  }
}
