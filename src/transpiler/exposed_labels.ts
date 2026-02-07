import type { ClassRegistry } from "./frontend/class_registry.js";
import type { UdonBehaviourLayouts } from "./ir/udon_behaviour_layout.js";

export function computeExposedLabels(
  registry: ClassRegistry,
  udonBehaviourLayouts: UdonBehaviourLayouts,
  entryClassName?: string | null,
): Set<string> {
  const exposed = new Set<string>();
  for (const cls of registry.getAllClasses()) {
    for (const method of cls.methods) {
      if (
        !method.isExported &&
        !(cls.name === entryClassName && method.isPublic)
      )
        continue;
      const layout = udonBehaviourLayouts.get(cls.name);
      if (layout) {
        const ml = layout.get(method.name);
        if (ml) exposed.add(ml.exportMethodName);
      }
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
