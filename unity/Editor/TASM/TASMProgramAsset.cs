using System;
using System.Reflection;
using UnityEngine;
using VRC.Udon.Common.Interfaces;
using VRC.Udon.EditorBindings;
using VRC.Udon.UAssembly.Assembler;
using VRC.Udon.UAssembly.Interfaces;

namespace VRC.Udon.Editor.ProgramSources
{
    public class TASMProgramAsset : UdonAssemblyProgramAsset
    {
        private static UdonEditorInterface _editorInterface;
        // Validated against VRC SDK 3.7.x; re-verify on major SDK updates.
        private static readonly FieldInfo _typeResolverGroupField =
            typeof(UdonEditorInterface).GetField("_typeResolverGroup",
                BindingFlags.NonPublic | BindingFlags.Instance);
        private static bool _initialized;

        private static void EnsureInitialized()
        {
            if (_initialized) return;
            if (UdonEditorManager.Instance == null)
                throw new InvalidOperationException(
                    "[TASM] UdonEditorManager not ready. "
                    + "Import may have been triggered too early.");
            UdonEditorManager.Instance.GetNodeRegistries();
            _editorInterface = new UdonEditorInterface();
            _editorInterface.AddTypeResolver(new UdonBehaviourTypeResolver());
            _initialized = true;
        }

        protected override void RefreshProgramImpl()
        {
            if (string.IsNullOrEmpty(udonAssembly))
            {
                program = null;
                assemblyError = "Assembly source is empty.";
                return;
            }

            try
            {
                EnsureInitialized();
                var typeResolver = _typeResolverGroupField?.GetValue(_editorInterface)
                    as IUAssemblyTypeResolver;
                if (typeResolver == null)
                    throw new InvalidOperationException(
                        "[TASM] Failed to get type resolver via reflection. "
                        + "VRC SDK may have changed.");

                uint heapSize = CalculateHeapSize(udonAssembly);
                program = AssembleWithHeapSize(udonAssembly, heapSize, typeResolver);
                assemblyError = null;
            }
            catch (Exception e)
            {
                program = null;
                assemblyError = e.Message;
                Debug.LogException(e);
            }
        }

        private static IUdonProgram AssembleWithHeapSize(
            string assembly, uint heapSize, IUAssemblyTypeResolver typeResolver)
        {
            const int maxRetries = 4;
            for (int i = 0; i < maxRetries; i++)
            {
                try
                {
                    var factory = new jp.ootr.TASM.Editor.HeapFactory
                        { FactoryHeapSize = heapSize };
                    var assembler = new UAssemblyAssembler(factory, typeResolver);
                    return assembler.Assemble(assembly);
                }
                catch (IndexOutOfRangeException) when (i < maxRetries - 1)
                {
                    heapSize *= 2;
                    Debug.LogWarning(
                        $"[TASM] Heap size insufficient, retrying with {heapSize}");
                }
            }
            throw new InvalidOperationException("Unreachable");
        }

        internal static uint CalculateHeapSize(string uasmText)
        {
            uint dataVarCount = 0;
            bool inDataSection = false;
            foreach (string rawLine in uasmText.Split('\n'))
            {
                string line = rawLine.Trim();
                if (line == ".data_start") { inDataSection = true; continue; }
                if (line == ".data_end") break;
                if (!inDataSection) continue;
                if (line.Length == 0 || line.StartsWith(".")) continue;
                int colonIdx = line.IndexOf(':');
                if (colonIdx <= 0) continue;
                dataVarCount++;
            }
            return Math.Max(dataVarCount + 128, 512);
        }
    }
}
