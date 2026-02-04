/**
 * Extern signature expansion tests
 */

import { describe, expect, it } from "vitest";
import {
  EXTERN_METHODS,
  EXTERN_PROPERTIES,
} from "../../../src/transpiler/codegen/extern_signatures";

describe("extern signatures expansion", () => {
  it("should include Mathf and String externs", () => {
    expect(EXTERN_METHODS.has("Mathf.Abs")).toBe(true);
    expect(EXTERN_METHODS.has("Mathf.Clamp")).toBe(true);
    expect(EXTERN_METHODS.has("String.Contains")).toBe(true);
    expect(EXTERN_METHODS.has("String.Substring(i)")).toBe(true);
    expect(EXTERN_METHODS.has("String.Substring(i,l)")).toBe(true);
  });

  it("should include Transform and GameObject properties", () => {
    expect(EXTERN_PROPERTIES.has("Transform.localPosition")).toBe(true);
    expect(EXTERN_PROPERTIES.has("Transform.localRotation")).toBe(true);
    expect(EXTERN_PROPERTIES.has("GameObject.activeSelf")).toBe(true);
    expect(EXTERN_PROPERTIES.has("GameObject.transform")).toBe(true);
  });
});
