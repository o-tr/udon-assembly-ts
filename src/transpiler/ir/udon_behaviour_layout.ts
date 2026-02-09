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

export type InterfaceLike = {
  name: string;
  methods: Array<{
    name: string;
    parameters: Array<{ name: string; type: TypeSymbol }>;
    returnType: TypeSymbol;
  }>;
};

const getUniqueId = (lookup: Map<string, number>, id: string): string => {
  const current = lookup.get(id) ?? 0;
  lookup.set(id, current + 1);
  return `__${current}_${id}`;
};

export const buildUdonBehaviourLayouts = (
  classes: ClassLike[],
  interfaces?: InterfaceLike[],
  classImplements?: Map<string, string[]>,
): UdonBehaviourLayouts => {
  const layouts: UdonBehaviourLayouts = new Map();

  // Phase 1: Build interface layouts with deterministic naming
  const interfaceLayouts = new Map<string, UdonBehaviourClassLayout>();
  if (interfaces) {
    for (const iface of interfaces) {
      const ifaceLayout: UdonBehaviourClassLayout = new Map();
      for (const method of iface.methods) {
        const exportMethodName = `${iface.name}_${method.name}`;
        const parameterExportNames: string[] = method.parameters.map(
          (_, i) => `${iface.name}_${method.name}__param_${i}`,
        );
        let returnExportName: string | null = null;
        if (method.returnType !== PrimitiveTypes.void) {
          returnExportName = `${iface.name}_${method.name}__ret`;
        }
        ifaceLayout.set(method.name, {
          exportMethodName,
          returnExportName,
          parameterExportNames,
          parameterTypes: method.parameters.map((p) => p.type),
          returnType: method.returnType,
          isPublic: true,
        });
      }
      interfaceLayouts.set(iface.name, ifaceLayout);
      layouts.set(iface.name, ifaceLayout);
    }
  }

  // Phase 2: Build class layouts, using interface names for interface methods
  // Collect interface method sets per class for quick lookup
  const classIfaceMethodMap = new Map<
    string,
    Map<string, { ifaceName: string; layout: UdonBehaviourMethodLayout }>
  >();
  if (classImplements && interfaceLayouts.size > 0) {
    for (const [className, ifaceNames] of classImplements) {
      const methodMap = new Map<
        string,
        { ifaceName: string; layout: UdonBehaviourMethodLayout }
      >();
      for (const ifaceName of ifaceNames) {
        const ifaceLayout = interfaceLayouts.get(ifaceName);
        if (!ifaceLayout) continue;
        for (const [methodName, methodLayout] of ifaceLayout) {
          if (!methodMap.has(methodName)) {
            methodMap.set(methodName, {
              ifaceName,
              layout: methodLayout,
            });
          }
        }
      }
      if (methodMap.size > 0) {
        classIfaceMethodMap.set(className, methodMap);
      }
    }
  }

  for (const cls of classes) {
    if (!cls.isUdonBehaviour) continue;
    const idLookup = new Map<string, number>();
    const classLayout: UdonBehaviourClassLayout = new Map();
    const ifaceMethodMap = classIfaceMethodMap.get(cls.name);

    for (const method of cls.methods) {
      // Check if this method is from an interface
      const ifaceInfo = ifaceMethodMap?.get(method.name);
      if (ifaceInfo) {
        // Use the interface's unified naming
        classLayout.set(method.name, {
          ...ifaceInfo.layout,
          isPublic: method.isPublic,
        });
        continue;
      }

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
