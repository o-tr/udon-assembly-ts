/**
 * Pluggable mapping from property names to structural / interface field types
 * for inline SoA and optional-chain lowering. Defaults preserve legacy behavior;
 * projects can supply a custom registry via ASTToTACConverter options.
 */

import type { ClassRegistry } from "../../frontend/class_registry.js";
import type { TypeMapper } from "../../frontend/type_mapper.js";
import {
  InterfaceTypeSymbol,
  type TypeSymbol,
} from "../../frontend/type_symbols.js";

export interface FieldTypeRegistryContext {
  typeMapper: TypeMapper;
  classRegistry: ClassRegistry | null;
}

export interface FieldTypeRegistry {
  getStructuralFieldType(property: string): TypeSymbol | undefined;
  getInterfacePropertyType(
    ctx: FieldTypeRegistryContext,
    interfaceName: string,
    property: string,
  ): TypeSymbol | undefined;
}

function defaultStructuralFieldType(_property: string): TypeSymbol | undefined {
  return undefined;
}

class DefaultFieldTypeRegistry implements FieldTypeRegistry {
  getStructuralFieldType(property: string): TypeSymbol | undefined {
    return defaultStructuralFieldType(property);
  }

  getInterfacePropertyType(
    ctx: FieldTypeRegistryContext,
    interfaceName: string,
    property: string,
  ): TypeSymbol | undefined {
    const fromRegistry = ctx.classRegistry
      ?.getInterface(interfaceName)
      ?.properties.find((p) => p.name === property);
    if (fromRegistry) {
      const t = fromRegistry.type;
      return t.name ? (ctx.typeMapper.getAlias(t.name) ?? t) : t;
    }

    const alias = ctx.typeMapper.getAlias(interfaceName);
    if (alias instanceof InterfaceTypeSymbol) {
      const raw = alias.properties.get(property);
      if (raw) {
        return raw.name ? (ctx.typeMapper.getAlias(raw.name) ?? raw) : raw;
      }
    }

    return undefined;
  }
}

export function createDefaultFieldTypeRegistry(): FieldTypeRegistry {
  return new DefaultFieldTypeRegistry();
}
