import type * as ts from "typescript";
import { TranspileError } from "../../errors/transpile_errors.js";
import { ASTNodeKind, type LiteralNode } from "../types.js";
import type { TypeScriptParser } from "./type_script_parser.js";

export function warnEnumInitializer(
  this: TypeScriptParser,
  node: ts.Expression,
  message: string,
): void {
  const sourceFile = this.sourceFile ?? node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const filePath = sourceFile.fileName || "<unknown>";
  console.warn(
    `Enum initializer warning: ${message} at ${filePath}:${position.line + 1}:${position.character + 1}`,
  );
}

export function reportTypeError(
  this: TypeScriptParser,
  node: ts.Node,
  message: string,
  suggestion?: string,
): void {
  const sourceFile = this.sourceFile ?? node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const filePath = sourceFile.fileName || "<unknown>";
  this.errorCollector.add(
    new TranspileError(
      "TypeError",
      message,
      {
        filePath,
        line: position.line + 1,
        column: position.character + 1,
      },
      suggestion,
    ),
  );
}

/**
 * Report unsupported syntax and stop parsing
 */
export function reportUnsupportedNode(
  this: TypeScriptParser,
  node: ts.Node,
  message: string,
  suggestion?: string,
): never {
  const sourceFile = this.sourceFile ?? node.getSourceFile();
  const start = node.pos >= 0 ? node.getStart() : 0;
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  const filePath = sourceFile.fileName || "<unknown>";

  throw new TranspileError(
    "UnsupportedSyntax",
    message,
    {
      filePath,
      line: position.line + 1,
      column: position.character + 1,
    },
    suggestion,
  );
}

/**
 * Placeholder expression for unsupported nodes
 * (Unreachable if reportUnsupportedNode throws)
 */
export function createUnsupportedExpressionPlaceholder(
  this: TypeScriptParser,
  tsNode?: ts.Node,
): LiteralNode {
  const result: LiteralNode = {
    kind: ASTNodeKind.Literal,
    value: 0,
    type: this.typeMapper.mapTypeScriptType("number"),
  };
  return tsNode ? this.attachLoc(tsNode, result) : result;
}
