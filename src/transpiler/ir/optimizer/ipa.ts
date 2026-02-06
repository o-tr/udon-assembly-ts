import {
  type ASTNode,
  ASTNodeKind,
  type ClassDeclarationNode,
  type ProgramNode,
} from "../../frontend/types.js";

export const pruneProgramByMethodUsage = (
  program: ProgramNode,
  usage: Map<string, Set<string>> | null,
): ProgramNode => {
  if (!usage) return program;

  const statements: ASTNode[] = program.statements.map((stmt) => {
    if (stmt.kind !== ASTNodeKind.ClassDeclaration) return stmt;
    const classNode = stmt as ClassDeclarationNode;
    const reachable = usage.get(classNode.name);
    if (!reachable) {
      return {
        ...classNode,
        methods: [],
      };
    }
    const filteredMethods = classNode.methods.filter((method) =>
      reachable.has(method.name),
    );
    return {
      ...classNode,
      methods: filteredMethods,
    };
  });

  return {
    ...program,
    statements,
  };
};
