import { describe, expect, it } from "vitest";
import { getVrcEventDefinition } from "../../../src/transpiler/vrc/event_registry";

describe("VRC event registry completeness", () => {
  it("registers additional UdonSharp events", () => {
    const eventNames = [
      "OnPlayerTriggerEnter",
      "OnPlayerCollisionStay",
      "OnPlayerRespawn",
      "OnStationEntered",
      "OnVideoError",
      "InputJump",
      "MidiNoteOn",
      "OnMasterTransferred",
      "OnAvatarEyeHeightChanged",
      "OnPlayerDataUpdated",
      "OnEnable",
      "OnDisable",
    ];

    for (const name of eventNames) {
      const def = getVrcEventDefinition(name);
      expect(def).toBeDefined();
      expect(def?.udonName.startsWith("_")).toBe(true);
    }
  });
});
