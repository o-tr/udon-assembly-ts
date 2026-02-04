/**
 * VRC.Udon.UdonBehaviour stub for extern resolution.
 */

import { UdonExtern, UdonStub } from "./UdonDecorators.js";
import type { NetworkEventTarget } from "./UdonTypes.js";

@UdonStub("VRC.Udon.UdonBehaviour")
export class UdonBehaviour {
  @UdonExtern({
    signature:
      "VRCUdonCommonInterfacesIUdonEventReceiver.__GetProgramVariable__SystemString__SystemObject",
  })
  GetProgramVariable(_name: string): unknown {
    return null;
  }

  @UdonExtern({
    signature:
      "VRCUdonCommonInterfacesIUdonEventReceiver.__SetProgramVariable__SystemString_SystemObject__SystemVoid",
  })
  SetProgramVariable(_name: string, _value: object): void {}

  @UdonExtern({
    signature:
      "VRCUdonCommonInterfacesIUdonEventReceiver.__SendCustomEvent__SystemString__SystemVoid",
  })
  SendCustomEvent(_eventName: string): void {}

  @UdonExtern({
    signature:
      "VRCUdonCommonInterfacesIUdonEventReceiver.__SendCustomNetworkEvent__VRCUdonCommonEnumsNetworkEventTarget_SystemString__SystemVoid",
  })
  SendCustomNetworkEvent(
    _target: NetworkEventTarget,
    _eventName: string,
  ): void {}

  @UdonExtern({
    signature:
      "VRCUdonCommonInterfacesIUdonEventReceiver.__RequestSerialization__SystemVoid",
  })
  RequestSerialization(): void {}
}
