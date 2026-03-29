/**
 * Vite plugin that transforms test case TypeScript files to handle
 * Udon-specific semantics in a JS runtime:
 *
 * 1. `expr as UdonInt` → `__castToInt(expr)` (truncation toward zero)
 * 2. `expr as UdonFloat` → `__castToFloat(expr)` (single-precision)
 * 3. `expr as UdonLong` → `__castToLong(expr)` (BigInt conversion)
 * 4. `expr as UdonULong` → `__castToULong(expr)` (BigInt unsigned)
 * 5. `nameof(ident)` → `"ident"` (string literal)
 * 6. Template literal expressions → `__udonFormat()` wrapped
 *
 * Only applies to files under tests/vm/cases/.
 */
import ts from "typescript";

// Use a minimal Plugin type to avoid depending on vite types directly
interface VitePlugin {
  name: string;
  enforce?: "pre" | "post";
  transform?: (
    code: string,
    id: string,
  ) => { code: string; map: null } | undefined;
}

const HELPERS = `
var __castToInt = (v) => typeof v === 'number' ? (v | 0) : v;
var __castToByte = (v) => typeof v === 'number' ? ((v | 0) & 0xFF) : v;
var __castToFloat = (v) => typeof v === 'number' ? Math.fround(v) : v;
var __castToLong = (v) => typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)));
var __castToULong = (v) => typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt.asUintN(64, BigInt(Math.trunc(Number(v))));
`;

// Udon branded types that need runtime cast behavior
const CAST_MAP: Record<string, string> = {
  UdonInt: "__castToInt",
  UdonFloat: "__castToFloat",
  UdonByte: "__castToByte",
  UdonLong: "__castToLong",
  UdonULong: "__castToULong",
};

export function udonCastPlugin(): VitePlugin {
  return {
    name: "udon-cast-transform",
    enforce: "pre",
    transform(code: string, id: string) {
      // Strip query string (e.g. ?t=... from cache-busted dynamic imports)
      // before checking path and extension, so transforms are never skipped.
      // Normalise backslashes to forward slashes for Windows compatibility.
      const cleanId = id.split("?")[0].replaceAll("\\", "/");
      // Only transform test case files
      if (!cleanId.includes("tests/vm/cases/")) return;
      if (!cleanId.endsWith(".ts")) return;

      const sourceFile = ts.createSourceFile(
        id,
        code,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS,
      );

      let needsHelpers = false;
      let needsUdonFormat = false;

      const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
        const visitor: ts.Visitor<ts.Node, ts.Node> = (
          node: ts.Node,
        ): ts.Node => {
          // Transform `as UdonInt` / `as UdonFloat` etc.
          if (ts.isAsExpression(node)) {
            const typeName = node.type.getText(sourceFile);
            const helperName = CAST_MAP[typeName];
            if (helperName) {
              needsHelpers = true;
              const inner = ts.visitEachChild(
                node.expression,
                visitor,
                context,
              );
              return ts.factory.createCallExpression(
                ts.factory.createIdentifier(helperName),
                undefined,
                [inner as ts.Expression],
              );
            }
          }

          // Transform `nameof(ident)` → `"ident"`
          if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "nameof" &&
            node.arguments.length === 1
          ) {
            const arg = node.arguments[0];
            if (ts.isIdentifier(arg)) {
              return ts.factory.createStringLiteral(arg.text);
            }
            // For property access: nameof(obj.prop) → "prop"
            if (ts.isPropertyAccessExpression(arg)) {
              return ts.factory.createStringLiteral(arg.name.text);
            }
            // Unsupported nameof argument form — fail fast at transform time
            throw new Error(
              `[udon-cast-plugin] Unsupported nameof() argument at position ${arg.pos} in ${cleanId}: ` +
                `expected identifier or property access, got ${ts.SyntaxKind[arg.kind]}`,
            );
          }

          // Transform template literals to use __udonFormat for each expression
          if (ts.isTemplateExpression(node)) {
            needsUdonFormat = true;
            // Build string concatenation: head + format(span1expr) + text1 + ...
            const parts: ts.Expression[] = [];

            // Template head (raw text before first expression)
            const headText = node.head.text;
            if (headText) {
              parts.push(ts.factory.createStringLiteral(headText));
            }

            for (const span of node.templateSpans) {
              const innerExpr = ts.visitEachChild(
                span.expression,
                visitor,
                context,
              );
              parts.push(
                ts.factory.createCallExpression(
                  ts.factory.createIdentifier("__udonFormat"),
                  undefined,
                  [innerExpr as ts.Expression],
                ),
              );
              // Template middle or tail text
              const spanText = span.literal.text;
              if (spanText) {
                parts.push(ts.factory.createStringLiteral(spanText));
              }
            }

            // Build left-to-right concatenation chain
            if (parts.length === 0) return ts.factory.createStringLiteral("");
            let result: ts.Expression = parts[0];
            for (let i = 1; i < parts.length; i++) {
              result = ts.factory.createBinaryExpression(
                result,
                ts.factory.createToken(ts.SyntaxKind.PlusToken),
                parts[i],
              );
            }
            return result;
          }

          return ts.visitEachChild(node, visitor, context);
        };

        return (sf: ts.SourceFile) =>
          ts.visitNode(sf, visitor) as ts.SourceFile;
      };

      const result = ts.transform(sourceFile, [transformer]);
      const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
      let output = printer.printFile(result.transformed[0]);
      result.dispose();

      // Prepend helpers if needed
      const preamble: string[] = [];
      if (needsHelpers) {
        preamble.push(HELPERS);
      }
      if (needsUdonFormat) {
        // Import udonFormat from the runtime capture module
        // Use the alias path which will be resolved by Vite
        preamble.push(
          `import { udonFormat as __udonFormat } from "@ootr/udon-assembly-ts/stubs/capture";\n`,
        );
      }

      if (preamble.length > 0) {
        output = preamble.join("") + output;
      }

      return {
        code: output,
        map: null,
      };
    },
  };
}
