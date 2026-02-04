/**
 * Type definitions for TypeScript to Udon transpiler frontend
 */

import type { TypeSymbol } from "./type_symbols.js";

/**
 * Udon primitive types supported by VRChat
 */
export enum UdonType {
  Int32 = "Int32",
  Single = "Single",
  Boolean = "Boolean",
  String = "String",
  Array = "Array",
  Void = "Void",
  Byte = "Byte",
  SByte = "SByte",
  Int16 = "Int16",
  UInt16 = "UInt16",
  UInt32 = "UInt32",
  Int64 = "Int64",
  UInt64 = "UInt64",
  Double = "Double",
  Vector2 = "Vector2",
  Vector3 = "Vector3",
  Vector4 = "Vector4",
  Quaternion = "Quaternion",
  Color = "Color",
  Transform = "Transform",
  GameObject = "GameObject",
  AudioSource = "AudioSource",
  AudioClip = "AudioClip",
  Animator = "Animator",
  Component = "Component",
  VRCPlayerApi = "VRCPlayerApi",
  UdonBehaviour = "UdonBehaviour",
  Object = "Object",
  Type = "Type",
  DataList = "DataList",
  DataDictionary = "DataDictionary",
  DataToken = "DataToken",
}

export interface SymbolInfo {
  name: string;
  type: TypeSymbol;
  scope: number;
  isParameter?: boolean;
  isConstant?: boolean;
  initialValue?: unknown;
}

/**
 * Simplified AST node types
 */
export enum ASTNodeKind {
  Program = "Program",
  VariableDeclaration = "VariableDeclaration",
  EnumDeclaration = "EnumDeclaration",
  EnumMember = "EnumMember",
  BinaryExpression = "BinaryExpression",
  UnaryExpression = "UnaryExpression",
  ConditionalExpression = "ConditionalExpression",
  NullCoalescingExpression = "NullCoalescingExpression",
  TemplateExpression = "TemplateExpression",
  Literal = "Literal",
  Identifier = "Identifier",
  ThisExpression = "ThisExpression",
  SuperExpression = "SuperExpression",
  ObjectLiteralExpression = "ObjectLiteralExpression",
  DeleteExpression = "DeleteExpression",
  ArrayLiteralExpression = "ArrayLiteralExpression",
  PropertyAccessExpression = "PropertyAccessExpression",
  IfStatement = "IfStatement",
  WhileStatement = "WhileStatement",
  ForStatement = "ForStatement",
  ForOfStatement = "ForOfStatement",
  SwitchStatement = "SwitchStatement",
  CaseClause = "CaseClause",
  DoWhileStatement = "DoWhileStatement",
  BreakStatement = "BreakStatement",
  ContinueStatement = "ContinueStatement",
  BlockStatement = "BlockStatement",
  FunctionDeclaration = "FunctionDeclaration",
  ClassDeclaration = "ClassDeclaration",
  MethodDeclaration = "MethodDeclaration",
  PropertyDeclaration = "PropertyDeclaration",
  InterfaceDeclaration = "InterfaceDeclaration",
  Decorator = "Decorator",
  CallExpression = "CallExpression",
  AsExpression = "AsExpression",
  ReturnStatement = "ReturnStatement",
  ArrayAccessExpression = "ArrayAccessExpression",
  AssignmentExpression = "AssignmentExpression",
  TryCatchStatement = "TryCatchStatement",
  ThrowStatement = "ThrowStatement",
  NameofExpression = "NameofExpression",
  TypeofExpression = "TypeofExpression",
  OptionalChainingExpression = "OptionalChainingExpression",
  UpdateExpression = "UpdateExpression",
}

/**
 * Base AST node
 */
export interface ASTNode {
  kind: ASTNodeKind;
}

/**
 * Program node (root)
 */
export interface ProgramNode extends ASTNode {
  kind: ASTNodeKind.Program;
  statements: ASTNode[];
}

/**
 * Variable declaration
 */
export interface VariableDeclarationNode extends ASTNode {
  kind: ASTNodeKind.VariableDeclaration;
  name: string;
  type: TypeSymbol;
  initializer?: ASTNode;
  isConst: boolean;
}

/**
 * Enum declaration
 */
export interface EnumDeclarationNode extends ASTNode {
  kind: ASTNodeKind.EnumDeclaration;
  name: string;
  members: EnumMemberNode[];
}

/**
 * Enum member
 */
export interface EnumMemberNode extends ASTNode {
  kind: ASTNodeKind.EnumMember;
  name: string;
  value: number | string;
}

/**
 * Binary expression (e.g., a + b, x < y)
 */
export interface BinaryExpressionNode extends ASTNode {
  kind: ASTNodeKind.BinaryExpression;
  operator: string;
  left: ASTNode;
  right: ASTNode;
}

/**
 * Unary expression (e.g., !x, -y)
 */
export interface UnaryExpressionNode extends ASTNode {
  kind: ASTNodeKind.UnaryExpression;
  operator: string;
  operand: ASTNode;
}

export interface UpdateExpressionNode extends ASTNode {
  kind: ASTNodeKind.UpdateExpression;
  operator: "+" | "-";
  operand: ASTNode;
  isPostfix: boolean;
}

/**
 * Conditional expression (e.g., cond ? a : b)
 */
export interface ConditionalExpressionNode extends ASTNode {
  kind: ASTNodeKind.ConditionalExpression;
  condition: ASTNode;
  whenTrue: ASTNode;
  whenFalse: ASTNode;
}

/**
 * Null coalescing expression (e.g., x ?? y)
 */
export interface NullCoalescingExpressionNode extends ASTNode {
  kind: ASTNodeKind.NullCoalescingExpression;
  left: ASTNode;
  right: ASTNode;
}

export type TemplatePart =
  | { kind: "text"; value: string }
  | { kind: "expression"; expression: ASTNode };

/**
 * Template expression (e.g., `Hello ${name}`)
 */
export interface TemplateExpressionNode extends ASTNode {
  kind: ASTNodeKind.TemplateExpression;
  parts: TemplatePart[];
}

/**
 * Literal value
 */
export interface LiteralNode extends ASTNode {
  kind: ASTNodeKind.Literal;
  value: number | string | boolean | bigint | null;
  type: TypeSymbol;
}

/**
 * Identifier (variable reference)
 */
export interface IdentifierNode extends ASTNode {
  kind: ASTNodeKind.Identifier;
  name: string;
}

/**
 * This expression
 */
export interface ThisExpressionNode extends ASTNode {
  kind: ASTNodeKind.ThisExpression;
}

/**
 * Super expression
 */
export interface SuperExpressionNode extends ASTNode {
  kind: ASTNodeKind.SuperExpression;
}

export type ObjectLiteralPropertyNode =
  | { kind: "property"; key: string; value: ASTNode }
  | { kind: "spread"; value: ASTNode };

/**
 * Object literal expression (e.g., { a: 1, ...b })
 */
export interface ObjectLiteralExpressionNode extends ASTNode {
  kind: ASTNodeKind.ObjectLiteralExpression;
  properties: ObjectLiteralPropertyNode[];
}

export type ArrayLiteralElementNode =
  | { kind: "element"; value: ASTNode }
  | { kind: "spread"; value: ASTNode };

/**
 * Array literal expression (e.g., [a, ...b])
 */
export interface ArrayLiteralExpressionNode extends ASTNode {
  kind: ASTNodeKind.ArrayLiteralExpression;
  elements: ArrayLiteralElementNode[];
  typeHint?: string;
}

/**
 * Delete expression (e.g., delete obj[key])
 */
export interface DeleteExpressionNode extends ASTNode {
  kind: ASTNodeKind.DeleteExpression;
  target: ASTNode;
}

/**
 * Property access (e.g., obj.x)
 */
export interface PropertyAccessExpressionNode extends ASTNode {
  kind: ASTNodeKind.PropertyAccessExpression;
  object: ASTNode;
  property: string;
}

/**
 * If statement
 */
export interface IfStatementNode extends ASTNode {
  kind: ASTNodeKind.IfStatement;
  condition: ASTNode;
  thenBranch: ASTNode;
  elseBranch?: ASTNode;
}

/**
 * While loop
 */
export interface WhileStatementNode extends ASTNode {
  kind: ASTNodeKind.WhileStatement;
  condition: ASTNode;
  body: ASTNode;
}

export interface SwitchStatementNode extends ASTNode {
  kind: ASTNodeKind.SwitchStatement;
  expression: ASTNode;
  cases: CaseClauseNode[];
}

export interface CaseClauseNode extends ASTNode {
  kind: ASTNodeKind.CaseClause;
  expression: ASTNode | null;
  statements: ASTNode[];
}

export interface DoWhileStatementNode extends ASTNode {
  kind: ASTNodeKind.DoWhileStatement;
  body: ASTNode;
  condition: ASTNode;
}

export interface BreakStatementNode extends ASTNode {
  kind: ASTNodeKind.BreakStatement;
}

export interface ContinueStatementNode extends ASTNode {
  kind: ASTNodeKind.ContinueStatement;
}

/**
 * For loop
 */
export interface ForStatementNode extends ASTNode {
  kind: ASTNodeKind.ForStatement;
  initializer?: ASTNode;
  condition?: ASTNode;
  incrementor?: ASTNode;
  body: ASTNode;
}

/**
 * For-of loop
 */
export interface ForOfStatementNode extends ASTNode {
  kind: ASTNodeKind.ForOfStatement;
  variable: string | string[];
  variableType?: string;
  destructureProperties?: Array<{ name: string; property: string }>;
  iterable: ASTNode;
  body: ASTNode;
}

/**
 * Block statement
 */
export interface BlockStatementNode extends ASTNode {
  kind: ASTNodeKind.BlockStatement;
  statements: ASTNode[];
}

/**
 * Function declaration
 */
export interface FunctionDeclarationNode extends ASTNode {
  kind: ASTNodeKind.FunctionDeclaration;
  name: string;
  parameters: Array<{ name: string; type: TypeSymbol }>;
  returnType: TypeSymbol;
  body: BlockStatementNode;
}

/**
 * Decorator
 */
export interface DecoratorNode extends ASTNode {
  kind: ASTNodeKind.Decorator;
  name: string;
  arguments: unknown[];
}

/**
 * Method declaration
 */
export interface MethodDeclarationNode extends ASTNode {
  kind: ASTNodeKind.MethodDeclaration;
  name: string;
  parameters: Array<{ name: string; type: TypeSymbol }>;
  returnType: TypeSymbol;
  body: BlockStatementNode;
  isPublic: boolean;
  isStatic: boolean;
  isRecursive?: boolean;
  isExported?: boolean;
}

/**
 * Property declaration
 */
export interface PropertyDeclarationNode extends ASTNode {
  kind: ASTNodeKind.PropertyDeclaration;
  name: string;
  type: TypeSymbol;
  initializer?: ASTNode;
  isPublic: boolean;
  isStatic: boolean;
  syncMode?: "None" | "Linear" | "Smooth";
  fieldChangeCallback?: string;
  isSerializeField?: boolean;
}

/**
 * Interface declaration
 */
export interface InterfaceDeclarationNode extends ASTNode {
  kind: ASTNodeKind.InterfaceDeclaration;
  name: string;
  properties: Array<{ name: string; type: TypeSymbol }>;
  methods: Array<{
    name: string;
    parameters: Array<{ name: string; type: TypeSymbol }>;
    returnType: TypeSymbol;
  }>;
}

/**
 * Class declaration
 */
export interface ClassDeclarationNode extends ASTNode {
  kind: ASTNodeKind.ClassDeclaration;
  name: string;
  baseClass: string | null;
  implements?: string[];
  decorators: DecoratorNode[];
  properties: PropertyDeclarationNode[];
  methods: MethodDeclarationNode[];
  constructor?: {
    parameters: Array<{ name: string; type: string }>;
    body: ASTNode;
  };
}

/**
 * Function call
 */
export interface CallExpressionNode extends ASTNode {
  kind: ASTNodeKind.CallExpression;
  callee: ASTNode;
  arguments: ASTNode[];
  typeArguments?: string[];
  isNew?: boolean;
}

/**
 * As expression (type assertion)
 */
export interface AsExpressionNode extends ASTNode {
  kind: ASTNodeKind.AsExpression;
  expression: ASTNode;
  targetType: string;
}

/**
 * Return statement
 */
export interface ReturnStatementNode extends ASTNode {
  kind: ASTNodeKind.ReturnStatement;
  value?: ASTNode;
}

/**
 * Try-catch-finally statement
 */
export interface TryCatchStatementNode extends ASTNode {
  kind: ASTNodeKind.TryCatchStatement;
  tryBody: BlockStatementNode;
  catchVariable?: string;
  catchBody?: BlockStatementNode;
  finallyBody?: BlockStatementNode;
}

/**
 * Throw statement
 */
export interface ThrowStatementNode extends ASTNode {
  kind: ASTNodeKind.ThrowStatement;
  expression: ASTNode;
}

/**
 * nameof expression
 */
export interface NameofExpressionNode extends ASTNode {
  kind: ASTNodeKind.NameofExpression;
  name: string;
}

/**
 * typeof expression
 */
export interface TypeofExpressionNode extends ASTNode {
  kind: ASTNodeKind.TypeofExpression;
  typeName: string;
}

/**
 * Optional chaining expression (obj?.prop)
 */
export interface OptionalChainingExpressionNode extends ASTNode {
  kind: ASTNodeKind.OptionalChainingExpression;
  object: ASTNode;
  property: string;
}

/**
 * Array access expression (e.g., arr[i])
 */
export interface ArrayAccessExpressionNode extends ASTNode {
  kind: ASTNodeKind.ArrayAccessExpression;
  array: ASTNode;
  index: ASTNode;
}

/**
 * Assignment expression (e.g., x = 5)
 */
export interface AssignmentExpressionNode extends ASTNode {
  kind: ASTNodeKind.AssignmentExpression;
  target: ASTNode;
  value: ASTNode;
}
