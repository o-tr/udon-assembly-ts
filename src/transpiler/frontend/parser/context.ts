import type * as ts from "typescript";
import type { ErrorCollector } from "../../errors/error_collector.js";
import type { EnumRegistry } from "../enum_registry.js";
import type { SymbolTable } from "../symbol_table.js";
import type { TypeMapper } from "../type_mapper.js";

export interface ParserContext {
  symbolTable: SymbolTable;
  errorCollector: ErrorCollector;
  sourceFile: ts.SourceFile | null;
  typeMapper: TypeMapper;
  enumRegistry: EnumRegistry;
  genericTypeParamStack: Array<Set<string>>;
  destructureCounter: number;
}
