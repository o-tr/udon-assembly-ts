import type { ClassRegistry } from "./frontend/class_registry.js";
import type { UdonBehaviourLayouts } from "./ir/udon_behaviour_layout.js";

export function computeExposedLabels(
  registry: ClassRegistry,
  udonBehaviourLayouts: UdonBehaviourLayouts,
  entryClassName?: string | null,
): Set<string> {
  const exposed = new Set<string>();

  // Collect interface layout keys for quick lookup
  const interfaceNames = new Set<string>();
  for (const iface of registry.getAllInterfaces()) {
    if (udonBehaviourLayouts.has(iface.name)) {
      interfaceNames.add(iface.name);
    }
  }

  for (const cls of registry.getAllClasses()) {
    const layout = udonBehaviourLayouts.get(cls.name);
    if (!layout) continue;

    // Check which interfaces this class implements
    const classIfaces = cls.node.implements ?? [];
    const implementedInterfaceMethodNames = new Set<string>();
    for (const ifaceName of classIfaces) {
      if (!interfaceNames.has(ifaceName)) continue;
      const ifaceLayout = udonBehaviourLayouts.get(ifaceName);
      if (ifaceLayout) {
        for (const methodName of ifaceLayout.keys()) {
          implementedInterfaceMethodNames.add(methodName);
        }
      }
    }

    for (const method of cls.methods) {
      const isEntryPublic = cls.name === entryClassName && method.isPublic;
      const isInterfaceMethod = implementedInterfaceMethodNames.has(
        method.name,
      );
      if (!method.isExported && !isEntryPublic && !isInterfaceMethod) continue;
      const ml = layout.get(method.name);
      if (ml) exposed.add(ml.exportMethodName);
    }
  }
  return exposed;
}

export function computeExportLabels(
  registry: ClassRegistry,
  udonBehaviourLayouts: UdonBehaviourLayouts,
  entryClassName?: string | null,
): Set<string> {
  return computeExposedLabels(registry, udonBehaviourLayouts, entryClassName);
}
