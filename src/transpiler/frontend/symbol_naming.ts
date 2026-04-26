/**
 * Strips a TypeScript module-qualifier prefix from a symbol name.
 * `getFullyQualifiedName` returns names like `"path/to/module".Foo`;
 * for Udon's purposes, only the trailing identifier matters.
 */
export function stripModuleQualifier(name: string): string {
  return name.replace(/^".*"\./, "");
}
