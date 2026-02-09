using System.IO;
using UnityEditor;
using UnityEngine;

namespace VRC.Udon.Editor.ProgramSources
{
    [UnityEditor.AssetImporters.ScriptedImporter(1, "tasm")]
    public class TASMImporter
        : UnityEditor.AssetImporters.ScriptedImporter
    {
        public override void OnImportAsset(
            UnityEditor.AssetImporters.AssetImportContext ctx)
        {
            Debug.Log("[TASM] Importing Udon Assembly Program");
            var asset = ScriptableObject.CreateInstance
                <TASMProgramAsset>();
            var serialized = new SerializedObject(asset);
            var prop = serialized.FindProperty("udonAssembly");
            if (prop == null)
            {
                Debug.LogError(
                    "[TASM] Could not find 'udonAssembly' property. "
                    + "SDK may have changed.");
                return;
            }
            prop.stringValue = File.ReadAllText(ctx.assetPath);
            serialized.ApplyModifiedProperties();
            asset.RefreshProgram();
            ctx.AddObjectToAsset("Imported Type Assembly Program", asset);
            ctx.SetMainObject(asset);
        }
    }
}
