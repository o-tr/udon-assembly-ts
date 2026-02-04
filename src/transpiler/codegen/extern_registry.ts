import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import {
  type MemberMetadata,
  typeMetadataRegistry,
} from "./type_metadata_registry.js";
import {
  clearExternTypeAliases,
  mapTypeScriptToCSharp,
  registerExternTypeAlias,
} from "./udon_type_resolver.js";

type DecoratorInfo = {
  name: string;
  args: Array<string | Record<string, string>>;
};

type StubClassInfo = {
  tsName: string;
  csharpFullName: string;
  node: ts.ClassDeclaration;
  sourceFile: ts.SourceFile;
};

type ExternOverride = {
  name?: string;
  signature?: string;
};

const DEFAULT_SCRIPT_TARGET = ts.ScriptTarget.ES2020;

export function buildExternRegistryFromFiles(filePaths: string[]): void {
  clearExternTypeAliases();
  typeMetadataRegistry.clear();

  const scanFiles = collectScanFiles(filePaths);
  const stubClasses: StubClassInfo[] = [];

  for (const filePath of scanFiles) {
    if (!isSupportedSource(filePath)) continue;
    let sourceText = "";
    try {
      sourceText = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      DEFAULT_SCRIPT_TARGET,
      true,
    );
    for (const node of sourceFile.statements) {
      if (!ts.isClassDeclaration(node) || !node.name) continue;
      const decorators = getDecorators(node, sourceFile);
      const udonStub = decorators.find((dec) => dec.name === "UdonStub");
      if (!udonStub && !isLikelyStubFile(filePath)) continue;
      const tsName = node.name.text;
      const csharpFullName = udonStub
        ? resolveStubCSharpName(tsName, udonStub)
        : mapTypeScriptToCSharp(tsName);
      stubClasses.push({ tsName, csharpFullName, node, sourceFile });
    }
  }

  for (const stub of stubClasses) {
    registerExternTypeAlias(stub.tsName, stub.csharpFullName);
  }

  for (const stub of stubClasses) {
    const members: Map<string, MemberMetadata[]> = new Map();
    let hasConstructor = false;

    for (const member of stub.node.members) {
      if (ts.isConstructorDeclaration(member)) {
        hasConstructor = true;
        const params = member.parameters.map((param) =>
          mapTypeScriptToCSharp(normalizeTypeText(param.type, stub.sourceFile)),
        );
        addMember(
          members,
          "ctor",
          {
            ownerCsharpType: stub.csharpFullName,
            memberName: "ctor",
            kind: "constructor",
            paramCsharpTypes: params,
            returnCsharpType: stub.csharpFullName,
            isStatic: false,
          },
          undefined,
        );
        continue;
      }

      if (ts.isMethodDeclaration(member) && member.name) {
        const tsMemberName = getMemberName(member.name, stub.sourceFile);
        if (!tsMemberName) continue;
        const decorators = getDecorators(member, stub.sourceFile);
        const override = getExternOverride(decorators);
        const paramTypes = member.parameters.map((param) =>
          mapTypeScriptToCSharp(normalizeTypeText(param.type, stub.sourceFile)),
        );
        const returnType = mapTypeScriptToCSharp(
          normalizeTypeText(member.type, stub.sourceFile, "void"),
        );
        const isStatic = hasStaticModifier(member);
        addMember(
          members,
          tsMemberName,
          {
            ownerCsharpType: stub.csharpFullName,
            memberName: override?.name ?? tsMemberName,
            kind: "method",
            paramCsharpTypes: paramTypes,
            returnCsharpType: returnType,
            isStatic,
          },
          override?.signature,
        );
        continue;
      }

      if (ts.isPropertyDeclaration(member) && member.name) {
        const tsMemberName = getMemberName(member.name, stub.sourceFile);
        if (!tsMemberName) continue;
        const decorators = getDecorators(member, stub.sourceFile);
        const override = getExternOverride(decorators);
        const returnType = mapTypeScriptToCSharp(
          normalizeTypeText(member.type, stub.sourceFile),
        );
        const isStatic = hasStaticModifier(member);
        addMember(
          members,
          tsMemberName,
          {
            ownerCsharpType: stub.csharpFullName,
            memberName: override?.name ?? tsMemberName,
            kind: "property",
            paramCsharpTypes: [],
            returnCsharpType: returnType,
            isStatic,
          },
          override?.signature,
        );
      }
    }

    if (!hasConstructor) {
      addMember(
        members,
        "ctor",
        {
          ownerCsharpType: stub.csharpFullName,
          memberName: "ctor",
          kind: "constructor",
          paramCsharpTypes: [],
          returnCsharpType: stub.csharpFullName,
          isStatic: false,
        },
        undefined,
      );
    }

    typeMetadataRegistry.registerType({
      csharpFullName: stub.csharpFullName,
      tsName: stub.tsName,
      members,
    });
  }
}

function addMember(
  members: Map<string, MemberMetadata[]>,
  tsName: string,
  metadata: Omit<MemberMetadata, "externSignature">,
  signature?: string,
): void {
  const entry: MemberMetadata = {
    ...metadata,
    externSignature: signature,
  };
  const list = members.get(tsName);
  if (list) {
    list.push(entry);
  } else {
    members.set(tsName, [entry]);
  }
}

function hasStaticModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : [];
  return !!modifiers?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword);
}

function resolveStubCSharpName(
  tsName: string,
  decorator: DecoratorInfo,
): string {
  const arg = decorator.args[0];
  if (typeof arg === "string" && arg.length > 0) {
    return arg;
  }
  return mapTypeScriptToCSharp(tsName);
}

function getMemberName(
  nameNode: ts.PropertyName,
  sourceFile: ts.SourceFile,
): string | null {
  if (ts.isIdentifier(nameNode)) return nameNode.text;
  if (ts.isStringLiteral(nameNode)) return nameNode.text;
  const raw = nameNode.getText(sourceFile).replace(/^['"]|['"]$/g, "");
  return raw || null;
}

function getExternOverride(
  decorators: DecoratorInfo[],
): ExternOverride | null {
  const udonExtern = decorators.find((dec) => dec.name === "UdonExtern");
  if (!udonExtern) return null;
  const arg = udonExtern.args[0];
  if (!arg) return {};
  if (typeof arg === "string") {
    if (arg.includes("__")) {
      return { signature: arg };
    }
    return { name: arg };
  }
  if (typeof arg === "object" && arg !== null) {
    const record = arg as Record<string, string>;
    return {
      name: record.name,
      signature: record.signature,
    };
  }
  return null;
}

function getDecorators(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): DecoratorInfo[] {
  const raw = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
  return raw.map((decorator) => {
    const expression = decorator.expression;
    if (ts.isCallExpression(expression)) {
      const name = getDecoratorName(expression.expression, sourceFile);
      const args = expression.arguments.map((arg) => {
        if (ts.isStringLiteral(arg)) {
          return arg.text;
        }
        if (ts.isObjectLiteralExpression(arg)) {
          const result: Record<string, string> = {};
          for (const prop of arg.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const key = prop.name.getText(sourceFile).replace(/^['"]|['"]$/g, "");
            const value = prop.initializer;
            if (ts.isStringLiteral(value)) {
              result[key] = value.text;
            } else {
              result[key] = value.getText(sourceFile).replace(/^['"]|['"]$/g, "");
            }
          }
          return result;
        }
        return arg.getText(sourceFile).replace(/^['"]|['"]$/g, "");
      });
      return { name, args };
    }
    return {
      name: getDecoratorName(expression, sourceFile),
      args: [],
    };
  });
}

function getDecoratorName(
  node: ts.LeftHandSideExpression,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return node.getText(sourceFile);
}

function normalizeTypeText(
  typeNode: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
  fallback = "object",
): string {
  if (!typeNode) return fallback;
  let text = typeNode.getText(sourceFile).trim();
  if (text.startsWith("readonly ")) {
    text = text.slice("readonly ".length).trim();
  }
  const arrayMatch = text.match(/^(ReadonlyArray|Array)<(.+)>$/);
  if (arrayMatch) {
    return `${arrayMatch[2].trim()}[]`;
  }
  if (text.includes("|")) {
    const parts = text
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part !== "null" && part !== "undefined");
    if (parts.length === 1) {
      return parts[0];
    }
    if (parts.length > 1) {
      return parts[0];
    }
  }
  return text;
}

function isSupportedSource(filePath: string): boolean {
  return (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".d.ts")
  );
}

function isLikelyStubFile(filePath: string): boolean {
  return (
    filePath.includes(`${path.sep}stubs${path.sep}`) ||
    filePath.includes(`${path.sep}node_modules${path.sep}`) ||
    filePath.endsWith(".d.ts")
  );
}

function collectScanFiles(filePaths: string[]): string[] {
  const unique = new Set<string>();
  for (const filePath of filePaths) {
    unique.add(filePath);
  }
  for (const dir of findBuiltinStubDirs()) {
    for (const filePath of walkTypescriptFiles(dir)) {
      unique.add(filePath);
    }
  }
  return Array.from(unique);
}

function findBuiltinStubDirs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../stubs"),
    path.resolve(here, "../../../stubs"),
  ];
  return candidates.filter((dir) => fs.existsSync(dir));
}

function walkTypescriptFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTypescriptFiles(entryPath));
      continue;
    }
    if (entry.isFile() && isSupportedSource(entryPath)) {
      results.push(entryPath);
    }
  }
  return results;
}
