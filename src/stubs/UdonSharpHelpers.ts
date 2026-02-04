/**
 * UdonSharp internal helper stubs.
 */

import { UdonStub } from "./UdonDecorators.js";
import type { UdonLong } from "./UdonTypes.js";
import type { Component } from "./UnityTypes.js";

@UdonStub("UdonSharp.Lib.Internal.GetComponentShim")
export class GetComponentShim {
  static GetComponent(
    _component: Component,
    _typeId: UdonLong,
  ): Component {
    return null as unknown as Component;
  }

  static GetComponentInChildren(
    _component: Component,
    _typeId: UdonLong,
  ): Component {
    return null as unknown as Component;
  }

  static GetComponentInParent(
    _component: Component,
    _typeId: UdonLong,
  ): Component {
    return null as unknown as Component;
  }
}
