import type { TypeSymbol } from "../frontend/type_symbols.js";
import { PrimitiveTypes } from "../frontend/type_symbols.js";
import { getVrcEventDefinition } from "../vrc/event_registry.js";

export type UdonBehaviourMethodLayout = {
  exportMethodName: string;
  returnExportName: string | null;
  parameterExportNames: string[];
  parameterTypes: TypeSymbol[];
  returnType: TypeSymbol;
  isPublic: boolean;
};

export type UdonBehaviourClassLayout = Map<string, UdonBehaviourMethodLayout>;

export type UdonBehaviourLayouts = Map<string, UdonBehaviourClassLayout>;

type MethodLike = {
  name: string;
  parameters: Array<{ name: string; type: TypeSymbol }>;
  returnType: TypeSymbol;
  isPublic: boolean;
};

type ClassLike = {
  name: string;
  isUdonBehaviour: boolean;
  methods: MethodLike[];
};

const getUniqueId = (lookup: Map<string, number>, id: string): string => {
  const current = lookup.get(id) ?? 0;
  lookup.set(id, current + 1);
  return `__${current}_${id}`;
};

export const buildUdonBehaviourLayouts = (
  classes: ClassLike[],
): UdonBehaviourLayouts => {
  const layouts: UdonBehaviourLayouts = new Map();

  for (const cls of classes) {
    if (!cls.isUdonBehaviour) continue;
    const idLookup = new Map<string, number>();
    const classLayout: UdonBehaviourClassLayout = new Map();

    for (const method of cls.methods) {
      let methodName = method.name;
      const parameterNames: string[] = new Array(method.parameters.length);
      let returnName: string | null = null;

      const eventDef = getVrcEventDefinition(method.name);
      if (eventDef) {
        methodName = eventDef.udonName;
        for (
          let i = 0;
          i < parameterNames.length && i < eventDef.parameters.length;
          i++
        ) {
          parameterNames[i] = eventDef.parameters[i].name;
        }
      } else {
        if (method.parameters.length > 0) {
          methodName = getUniqueId(idLookup, methodName);
        }
        for (let i = 0; i < method.parameters.length; i++) {
          parameterNames[i] = getUniqueId(
            idLookup,
            `${method.parameters[i].name}__param`,
          );
        }
      }

      if (method.returnType !== PrimitiveTypes.void) {
        returnName = getUniqueId(idLookup, `${methodName}__ret`);
      }

      classLayout.set(method.name, {
        exportMethodName: methodName,
        returnExportName: returnName,
        parameterExportNames: parameterNames,
        parameterTypes: method.parameters.map((param) => param.type),
        returnType: method.returnType,
        isPublic: method.isPublic,
      });
    }

    layouts.set(cls.name, classLayout);
  }

  return layouts;
};
