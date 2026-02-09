/**
 * Inheritance validator for UdonSharpBehaviour chain
 */

import type { ErrorCollector } from "../errors/error_collector.js";
import { TranspileError } from "../errors/transpile_errors.js";
import type { ClassRegistry } from "./class_registry.js";

const UDON_SHARP_BEHAVIOUR = "UdonSharpBehaviour";

export class InheritanceValidator {
  constructor(
    private registry: ClassRegistry,
    private errorCollector: ErrorCollector,
  ) {}

  validate(className: string): void {
    const visited = new Set<string>();
    let current = this.registry.getClass(className);

    if (!current) {
      this.errorCollector.add(
        new TranspileError(
          "TypeError",
          `Unknown class '${className}'`,
          { filePath: "<unknown>", line: 1, column: 1 },
          "Ensure the class is declared in the transpile scope.",
        ),
      );
      return;
    }

    this.validateInterfaces(className, current.filePath);

    while (current) {
      if (visited.has(current.name)) {
        this.errorCollector.add(
          new TranspileError(
            "TypeError",
            `Cyclic inheritance detected at '${current.name}'`,
            { filePath: current.filePath, line: 1, column: 1 },
            "Remove the circular dependency in class inheritance.",
          ),
        );
        return;
      }
      visited.add(current.name);

      if (current.name === UDON_SHARP_BEHAVIOUR) {
        return;
      }
      if (current.baseClass === UDON_SHARP_BEHAVIOUR) {
        return;
      }

      if (!current.baseClass) {
        this.errorCollector.add(
          new TranspileError(
            "TypeError",
            `Class '${className}' does not inherit from ${UDON_SHARP_BEHAVIOUR}`,
            { filePath: current.filePath, line: 1, column: 1 },
            `Extend ${UDON_SHARP_BEHAVIOUR} or a subclass of it.`,
          ),
        );
        return;
      }

      current = this.registry.getClass(current.baseClass) ?? undefined;
      if (!current) {
        this.errorCollector.add(
          new TranspileError(
            "TypeError",
            `Base class '${className}' inheritance chain is missing`,
            { filePath: "<unknown>", line: 1, column: 1 },
            "Ensure base classes are included in the transpile scope.",
          ),
        );
        return;
      }
    }
  }

  validateUdonBehaviourInterfaceConsistency(
    udonBehaviourInterfaces: Set<string>,
  ): void {
    for (const cls of this.registry.getAllClasses()) {
      const isUdonBehaviour = cls.decorators.some(
        (d) => d.name === "UdonBehaviour",
      );
      if (isUdonBehaviour) continue;
      const impls = cls.node.implements ?? [];
      for (const ifaceName of impls) {
        if (udonBehaviourInterfaces.has(ifaceName)) {
          this.errorCollector.add(
            new TranspileError(
              "TypeError",
              `Class '${cls.name}' implements UdonBehaviour interface '${ifaceName}' but is not decorated with @UdonBehaviour`,
              { filePath: cls.filePath, line: 1, column: 1 },
              "Add the @UdonBehaviour decorator to this class or remove the interface implementation.",
            ),
          );
        }
      }
    }
  }

  private validateInterfaces(className: string, filePath: string): void {
    const classMeta = this.registry.getClass(className);
    const implementsList = classMeta?.node.implements ?? [];
    if (implementsList.length === 0) return;

    const mergedMethods = this.registry.getMergedMethods(className);
    const mergedProps = this.registry.getMergedProperties(className);

    for (const ifaceName of implementsList) {
      const iface = this.registry.getInterface(ifaceName);
      if (!iface) {
        this.errorCollector.add(
          new TranspileError(
            "TypeError",
            `Unknown interface '${ifaceName}' implemented by '${className}'`,
            { filePath, line: 1, column: 1 },
            "Ensure the interface is declared in the transpile scope.",
          ),
        );
        continue;
      }

      for (const ifaceMethod of iface.methods) {
        const hasMethod = mergedMethods.some(
          (method) => method.name === ifaceMethod.name,
        );
        if (!hasMethod) {
          this.errorCollector.add(
            new TranspileError(
              "TypeError",
              `Class '${className}' is missing method '${ifaceMethod.name}' from interface '${ifaceName}'`,
              { filePath, line: 1, column: 1 },
              "Implement the missing interface method.",
            ),
          );
        }
      }

      for (const ifaceProp of iface.properties) {
        const hasProp = mergedProps.some(
          (prop) => prop.name === ifaceProp.name,
        );
        if (!hasProp) {
          this.errorCollector.add(
            new TranspileError(
              "TypeError",
              `Class '${className}' is missing property '${ifaceProp.name}' from interface '${ifaceName}'`,
              { filePath, line: 1, column: 1 },
              "Implement the missing interface property.",
            ),
          );
        }
      }
    }
  }
}
