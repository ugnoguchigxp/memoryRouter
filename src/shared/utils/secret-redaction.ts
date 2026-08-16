const REDACTION_PLACEHOLDER = "[REMOVED SENSITIVE DATA]";

const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)* PRIVATE KEY-----/g;
const URL_SECRET_QUERY_PATTERN =
  /([?&](?:(?:x[_-]?)?admin[_-]?api[_-]?key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password)=)[^&\s"']+/gi;
const ENV_ASSIGNMENT_PATTERN =
  /(^|[\s;])((?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|\[REMOVED SENSITIVE DATA\]|[^\s;]+)/gim;
const LABELED_VALUE_PATTERN =
  /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?)(\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|\[REMOVED SENSITIVE DATA\]|[^\r\n,}\]]+)/gim;

const SECRET_PATTERNS: RegExp[] = [
  PRIVATE_KEY_BLOCK_PATTERN,
  /(?:^|\b)export\s+[A-Z_]*(?:PASSWORD|TOKEN|KEY)\s*=\s*["']?[A-Za-z0-9_\-./+=]{12,}["']?$/gim,
  /\b(?:password|passphrase|secret(?:[_-]?key)?|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{12,}["']?/gi,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{4,}=*/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  /(\B--(?:api-key|token|password|secret|client-secret)(?:=|\s+))["']?[^\s"']+["']?/gi,
];

const SENSITIVE_SINGLE_WORD_KEYS = new Set([
  "authorization",
  "credential",
  "credentials",
  "passphrase",
  "password",
  "secret",
  "token",
]);

const SENSITIVE_COMPACT_KEY_PARTS = [
  "apikey",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearertoken",
  "clientsecret",
  "secretkey",
  "privatekey",
  "accesskeyid",
  "connectionstring",
  "databaseurl",
];

function isSensitiveObjectKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((word) => SENSITIVE_SINGLE_WORD_KEYS.has(word))) return true;
  if (words.includes("api") && words.includes("key")) return true;
  if (words.includes("private") && words.includes("key")) return true;
  if (words.includes("secret") && words.includes("key")) return true;
  if (
    words.includes("token") &&
    words.some((word) => ["access", "auth", "bearer", "id", "refresh"].includes(word))
  ) {
    return true;
  }

  const compact = words.join("");
  return SENSITIVE_COMPACT_KEY_PARTS.some((part) => compact.includes(part));
}

function isSensitiveEnvironmentKey(key: string): boolean {
  const normalized = key.trim().replace(/^["']|["']$/g, "");
  if (isSensitiveObjectKey(normalized)) return true;
  const upper = normalized.toUpperCase();
  if (upper === "DATABASE_URL" || upper === "PGPASSWORD") return true;
  if (upper.endsWith("_DSN") || upper.endsWith("_CONNECTION_STRING")) return true;
  const words = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  return words.includes("ACCESS") && words.includes("KEY");
}

function redactAssignmentValue(match: string, prefix: string): string {
  const rawValue = match.slice(prefix.length);
  if (rawValue.includes(REDACTION_PLACEHOLDER)) return match;
  const quote = rawValue.startsWith('"') ? '"' : rawValue.startsWith("'") ? "'" : "";
  return `${prefix}${quote}${REDACTION_PLACEHOLDER}${quote}`;
}

function redactStructuredAssignments(text: string): string {
  const environmentRedacted = text.replace(
    ENV_ASSIGNMENT_PATTERN,
    (match, leading: string, exported: string, key: string, separator: string) => {
      if (!isSensitiveEnvironmentKey(key)) return match;
      const prefix = `${leading}${exported}${key}${separator}`;
      return redactAssignmentValue(match, prefix);
    },
  );
  return environmentRedacted.replace(
    LABELED_VALUE_PATTERN,
    (match, openingQuote: string, key: string, closingQuote: string, separator: string) => {
      if (!isSensitiveEnvironmentKey(key)) return match;
      const prefix = `${openingQuote}${key}${closingQuote}${separator}`;
      return redactAssignmentValue(match, prefix);
    },
  );
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function redactSecrets(text: string): string {
  let redacted = redactStructuredAssignments(text).replace(
    URL_SECRET_QUERY_PATTERN,
    `$1${REDACTION_PLACEHOLDER}`,
  );
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return redacted;
}

function hasRedactableSensitiveValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object" && isPlainRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return false;
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveObjectKey(key) && hasRedactableSensitiveValue(value)) {
    return REDACTION_PLACEHOLDER;
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, key));
  }
  if (value && typeof value === "object" && isPlainRecord(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      redacted[entryKey] = redactValue(entryValue, entryKey);
    }
    return redacted;
  }
  return value;
}

export function redactSecretsFromValue(value: unknown): unknown {
  return redactValue(value);
}

export function redactSecretRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactValue(value) as Record<string, unknown>;
}
