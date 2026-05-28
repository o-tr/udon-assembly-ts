export function sanitizeIdentifierToken(raw: string): string {
  const replaced = raw.replace(/[^A-Za-z0-9_]/g, "_");
  const normalized =
    replaced.length === 0
      ? "_anon"
      : /^[A-Za-z_]/.test(replaced)
        ? replaced
        : `_${replaced}`;
  if (normalized === raw) return normalized;
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${normalized}__h${hash.toString(16)}`;
}
