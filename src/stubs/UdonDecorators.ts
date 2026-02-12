/**
 * UdonSharp互換用のデコレータースタブ
 */

export const UdonStatic: ClassDecorator = () => undefined;
export const UdonExport: MethodDecorator = () => undefined;
export function UdonExtern(
  _options?: string | { name?: string; signature?: string },
): MethodDecorator & PropertyDecorator {
  return () => undefined;
}
// Transpiler strips TsOnly calls from UASM; TS runtime executes the callback.
export function TsOnly(action: () => void): void {
  action();
}
export const UdonTsOnly = TsOnly;

export function UdonBehaviour(_options?: {
  syncMode?: "None" | "Continuous" | "Manual";
}): ClassDecorator {
  return () => undefined;
}
export const SerializeField: PropertyDecorator & ParameterDecorator = () =>
  undefined;

// UdonSharp stub requires generic arguments
export function UdonStub(target: (...args: never[]) => unknown): void;
export function UdonStub(typePath?: string): ClassDecorator;
// UdonSharp stub requires generic arguments
export function UdonStub(
  arg?: string | ((...args: never[]) => unknown),
): ClassDecorator | undefined {
  if (typeof arg === "function") {
    return;
  }
  return () => undefined;
}
