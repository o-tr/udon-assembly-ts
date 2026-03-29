import path from "node:path";
import { defineConfig } from "vitest/config";
import { udonCastPlugin } from "./tests/vm/vite-udon-cast-plugin.js";

export default defineConfig({
  plugins: [udonCastPlugin()],
  resolve: {
    alias: {
      "@ootr/udon-assembly-ts/stubs/UnityTypes": path.resolve(
        import.meta.dirname,
        "tests/vm/runtime-stubs/UnityTypes.ts",
      ),
      "@ootr/udon-assembly-ts/stubs/DataContainerTypes": path.resolve(
        import.meta.dirname,
        "tests/vm/runtime-stubs/DataContainerTypes.ts",
      ),
      "@ootr/udon-assembly-ts/stubs/SystemTypes": path.resolve(
        import.meta.dirname,
        "tests/vm/runtime-stubs/SystemTypes.ts",
      ),
      "@ootr/udon-assembly-ts/stubs/UdonDecorators": path.resolve(
        import.meta.dirname,
        "tests/vm/runtime-stubs/UdonDecorators.ts",
      ),
      "@ootr/udon-assembly-ts/stubs/UdonSharpBehaviour": path.resolve(
        import.meta.dirname,
        "tests/vm/runtime-stubs/UdonSharpBehaviour.ts",
      ),
      "@ootr/udon-assembly-ts/stubs/UdonTypes": path.resolve(
        import.meta.dirname,
        "tests/vm/runtime-stubs/UdonTypes.ts",
      ),
      "@ootr/udon-assembly-ts/stubs/capture": path.resolve(
        import.meta.dirname,
        "tests/vm/runtime-stubs/capture.ts",
      ),
    },
  },
  test: {
    globals: true,
  },
});
