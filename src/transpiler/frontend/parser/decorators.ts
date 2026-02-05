import * as ts from "typescript";

/**
 * Lightweight helper: extract class decorator names from source using ts.createSourceFile
 */
export function extractClassDecoratorsFromSource(
  sourceCode: string,
  filePath = "temp.ts",
): Array<{ className: string; decorators: string[] }> {
  const src = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.ES2020,
    true,
  );
  const results: Array<{ className: string; decorators: string[] }> = [];

  ts.forEachChild(src, (node) => {
    if (!ts.isClassDeclaration(node)) return;
    const name = node.name?.text ?? "";
    const decs: string[] = [];
    const decorators = ts.canHaveDecorators(node)
      ? (ts.getDecorators(node) ?? [])
      : [];
    for (const dec of decorators) {
      const expr = dec.expression as ts.Expression;
      if (ts.isCallExpression(expr)) {
        const e = expr.expression;
        if (ts.isIdentifier(e)) decs.push(e.escapedText?.toString() ?? "");
      } else if (ts.isIdentifier(expr)) {
        decs.push(expr.escapedText?.toString() ?? "");
      } else {
        decs.push(expr.getText());
      }
    }
    results.push({ className: name, decorators: decs });
  });

  return results;
}
