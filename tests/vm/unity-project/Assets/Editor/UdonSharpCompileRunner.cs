using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

/// <summary>
/// Compiles UdonSharp C# source files to UASM text using the SDK's compiler.
///
/// Strategy:
///   1. Copy .cs files into Assets/UdonSharpInput/
///   2. Refresh AssetDatabase (MonoScript discovery)
///   3. Create UdonSharpProgramAsset for each script
///   4. Compile via UdonSharpProgramAsset.CompileAllCsPrograms()
///   5. Read UASM text via UdonSharpEditorCache.GetUASMStr()
///   6. Output UASM files + results JSON
///
/// Usage (Unity batch mode):
///   Unity -batchmode -nographics -projectPath <path>
///         -executeMethod UdonSharpCompileRunner.CompileToUasm
///         -udonSharpInputDir <dir>   (contains compile_manifest.json + .cs files)
///         -udonSharpOutputDir <dir>  (where .uasm files + compile_results.json are written)
///         -logFile <log> -quit
/// </summary>
public static class UdonSharpCompileRunner
{
    #region JSON types

    [Serializable]
    private class CompileManifest
    {
        public SourceEntry[] sources;
    }

    [Serializable]
    private class SourceEntry
    {
        public string name;
        public string className;
        public string csFile;
    }

    [Serializable]
    private class CompileResults
    {
        public CompileResultEntry[] results;
    }

    [Serializable]
    private class CompileResultEntry
    {
        public string name;
        public string className;
        public string uasmFile;
        public string error;
    }

    #endregion

    private const string INPUT_SUBDIR = "UdonSharpInput";

    public static void CompileToUasm()
    {
        var projectRoot = Path.Combine(Application.dataPath, "..");
        var inputDir = Path.Combine(projectRoot, "UdonSharpInput");
        var outputDir = Path.Combine(projectRoot, "UdonSharpOutput");

        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "-udonSharpInputDir") inputDir = args[i + 1];
            if (args[i] == "-udonSharpOutputDir") outputDir = args[i + 1];
        }

        Debug.Log($"[UdonSharpCompileRunner] Input dir: {inputDir}");
        Debug.Log($"[UdonSharpCompileRunner] Output dir: {outputDir}");

        Directory.CreateDirectory(outputDir);

        // Read manifest
        var manifestPath = Path.Combine(inputDir, "compile_manifest.json");
        if (!File.Exists(manifestPath))
        {
            Debug.LogError($"[UdonSharpCompileRunner] compile_manifest.json not found at {manifestPath}");
            EditorApplication.Exit(1);
            return;
        }

        var manifestJson = File.ReadAllText(manifestPath).TrimStart('\uFEFF');
        var manifest = JsonUtility.FromJson<CompileManifest>(manifestJson);
        if (manifest?.sources == null || manifest.sources.Length == 0)
        {
            Debug.LogError("[UdonSharpCompileRunner] No sources in manifest");
            EditorApplication.Exit(1);
            return;
        }

        Debug.Log($"[UdonSharpCompileRunner] Compiling {manifest.sources.Length} source(s)...");

        var resultEntries = new List<CompileResultEntry>();
        var createdAssets = new List<string>(); // paths to clean up

        try
        {
            resultEntries = CompileSources(manifest.sources, inputDir, outputDir, createdAssets);
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            // Write partial results
        }
        finally
        {
            Cleanup(createdAssets);
        }

        // Write results JSON
        var compileResults = new CompileResults { results = resultEntries.ToArray() };
        var resultJson = JsonUtility.ToJson(compileResults, true);
        File.WriteAllText(Path.Combine(outputDir, "compile_results.json"), resultJson, Encoding.UTF8);

        var failCount = resultEntries.Count(r => !string.IsNullOrEmpty(r.error));
        Debug.Log($"[UdonSharpCompileRunner] Done: {resultEntries.Count - failCount}/{resultEntries.Count} succeeded");

        EditorApplication.Exit(failCount > 0 ? 1 : 0);
    }

    private static List<CompileResultEntry> CompileSources(
        SourceEntry[] sources, string inputDir, string outputDir, List<string> createdAssets)
    {
        // NOTE: .cs files were copied by the TypeScript orchestrator BEFORE Unity started,
        // so they were compiled during Unity's initial domain reload.
        // Assets/UdonSharpInput/ and .asset files already exist.

        var assetsInputDir = Path.Combine(Application.dataPath, INPUT_SUBDIR);
        createdAssets.Add($"Assets/{INPUT_SUBDIR}"); // register for cleanup

        // Step 1: Find UdonSharpProgramAsset type
        var programAssetType = GetType("UdonSharp.UdonSharpProgramAsset");
        if (programAssetType == null)
            throw new InvalidOperationException("[UdonSharpCompileRunner] UdonSharpProgramAsset type not found");

        var programAssets = new Dictionary<string, UnityEngine.Object>(); // name -> asset

        foreach (var source in sources)
        {
            // Find the MonoScript (already compiled during startup)
            var monoScriptPath = $"Assets/{INPUT_SUBDIR}/{source.csFile}";
            var monoScript = AssetDatabase.LoadAssetAtPath<MonoScript>(monoScriptPath);
            if (monoScript == null)
            {
                Debug.LogWarning($"[UdonSharpCompileRunner] MonoScript not found: {monoScriptPath}");
                continue;
            }

            // Find existing UdonSharpProgramAsset (auto-created by UdonSharp during startup)
            var asset = TryGetExistingProgramAsset(monoScript, programAssetType);
            if (asset == null)
            {
                // Auto-creation may not have happened; create it now and compile
                asset = CreateProgramAsset(monoScript, source, programAssetType, createdAssets);
            }

            if (asset != null)
            {
                programAssets[source.name] = asset;
                Debug.Log($"[UdonSharpCompileRunner] Program asset ready for: {source.name}");
            }
        }

        // Step 2: Trigger compilation (needed even after startup compilation,
        // in case GetUASMStr was not populated during initial load)
        Debug.Log("[UdonSharpCompileRunner] Triggering UdonSharp compilation...");
        TriggerCompilation(programAssetType);

        // Step 5: Extract UASM via UdonSharpEditorCache.GetUASMStr
        var results = new List<CompileResultEntry>();

        foreach (var source in sources)
        {
            var entry = new CompileResultEntry
            {
                name = source.name,
                className = source.className,
                uasmFile = $"{source.className}.uasm",
                error = "",
            };

            if (!programAssets.TryGetValue(source.name, out var asset))
            {
                entry.error = "Program asset creation failed";
                results.Add(entry);
                continue;
            }

            try
            {
                var uasmText = ExtractUasm(asset, programAssetType);
                if (string.IsNullOrEmpty(uasmText))
                {
                    entry.error = "UASM text is empty after compilation";
                    Debug.LogWarning($"[UdonSharpCompileRunner] Empty UASM for {source.name}");
                }
                else
                {
                    var outPath = Path.Combine(outputDir, entry.uasmFile);
                    File.WriteAllText(outPath, uasmText, Encoding.UTF8);
                    Debug.Log($"[UdonSharpCompileRunner] Wrote {outPath} ({uasmText.Length} chars)");
                }
            }
            catch (Exception e)
            {
                entry.error = $"{e.GetType().Name}: {e.Message}";
                Debug.LogException(e);
            }

            results.Add(entry);
        }

        return results;
    }

    private static UnityEngine.Object TryGetExistingProgramAsset(
        MonoScript monoScript, Type programAssetType)
    {
        // Try UdonSharpEditorUtility.GetUdonSharpProgramAsset(MonoScript)
        var utilType = GetType("UdonSharpEditor.UdonSharpEditorUtility");
        if (utilType == null) return null;

        var getAsset = utilType.GetMethod("GetUdonSharpProgramAsset",
            BindingFlags.Public | BindingFlags.Static,
            null, new[] { typeof(MonoScript) }, null);
        if (getAsset == null) return null;

        try
        {
            var result = getAsset.Invoke(null, new object[] { monoScript });
            if (result != null)
                Debug.Log($"[UdonSharpCompileRunner] Found existing program asset via EditorUtility");
            return result as UnityEngine.Object;
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[UdonSharpCompileRunner] GetUdonSharpProgramAsset failed: {e.Message}");
            return null;
        }
    }

    private static UnityEngine.Object CreateProgramAsset(
        MonoScript monoScript, SourceEntry source, Type programAssetType, List<string> createdAssets)
    {
        // Create a new UdonSharpProgramAsset ScriptableObject
        var asset = ScriptableObject.CreateInstance(programAssetType);
        if (asset == null)
        {
            Debug.LogError($"[UdonSharpCompileRunner] CreateInstance<UdonSharpProgramAsset> returned null");
            return null;
        }

        // Set sourceCsScript field (public field)
        var sourceCsField = programAssetType.GetField("sourceCsScript",
            BindingFlags.Public | BindingFlags.Instance);
        if (sourceCsField == null)
        {
            Debug.LogError("[UdonSharpCompileRunner] sourceCsScript field not found");
            UnityEngine.Object.DestroyImmediate(asset);
            return null;
        }
        sourceCsField.SetValue(asset, monoScript);

        // Save to AssetDatabase so it can be compiled
        var assetPath = $"Assets/{INPUT_SUBDIR}/{source.className}.asset";
        AssetDatabase.CreateAsset(asset, assetPath);
        AssetDatabase.SaveAssets();
        createdAssets.Add(assetPath);
        Debug.Log($"[UdonSharpCompileRunner] Created program asset at {assetPath}");

        // Reload from AssetDatabase
        return AssetDatabase.LoadAssetAtPath(assetPath, programAssetType);
    }

    private static void TriggerCompilation(Type programAssetType)
    {
        // Use UdonSharpCompilerV1.CompileSync() which starts the async compile and waits for
        // completion. CompileSync calls WaitForCompile() after Compile(), and WaitForCompile()
        // calls TickCompile() which writes UASM to the cache via SetUASMStr().
        // Note: CompileAllCsPrograms() starts an async Task and returns immediately; it must
        // be followed by WaitForCompile(), which is exactly what CompileSync() does.
        var compilerType = GetType("UdonSharp.Compiler.UdonSharpCompilerV1");
        if (compilerType != null)
        {
            // Primary: CompileSync(options)
            var compileSync = compilerType.GetMethod("CompileSync",
                BindingFlags.Public | BindingFlags.Static);
            if (compileSync != null)
            {
                try
                {
                    var paramInfos = compileSync.GetParameters();
                    object options = null;
                    if (paramInfos.Length > 0)
                    {
                        options = TryCreateCompileOptions(paramInfos[0].ParameterType);
                    }
                    compileSync.Invoke(null, options != null ? new[] { options } : null);
                    Debug.Log("[UdonSharpCompileRunner] CompileSync() completed");
                    return;
                }
                catch (Exception e)
                {
                    Debug.LogWarning($"[UdonSharpCompileRunner] CompileSync failed: {e.InnerException?.Message ?? e.Message}");
                }
            }

            // Fallback: Compile() + WaitForCompile()
            var compile = compilerType.GetMethod("Compile",
                BindingFlags.Public | BindingFlags.Static);
            var waitForCompile = compilerType.GetMethod("WaitForCompile",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (compile != null && waitForCompile != null)
            {
                try
                {
                    var paramInfos = compile.GetParameters();
                    object options = null;
                    if (paramInfos.Length > 0)
                        options = TryCreateCompileOptions(paramInfos[0].ParameterType);
                    compile.Invoke(null, options != null ? new[] { options } : null);
                    waitForCompile.Invoke(null, null);
                    Debug.Log("[UdonSharpCompileRunner] Compile() + WaitForCompile() completed");
                    return;
                }
                catch (Exception e)
                {
                    Debug.LogWarning($"[UdonSharpCompileRunner] Compile+WaitForCompile failed: {e.InnerException?.Message ?? e.Message}");
                }
            }
        }

        // Last resort: CompileAllCsPrograms (async, may not populate cache before GetUASMStr)
        var compileAll = programAssetType.GetMethod("CompileAllCsPrograms",
            BindingFlags.Public | BindingFlags.Static);
        if (compileAll != null)
        {
            var paramInfos = compileAll.GetParameters();
            try
            {
                if (paramInfos.Length == 0)
                    compileAll.Invoke(null, null);
                else if (paramInfos.Length == 2)
                    compileAll.Invoke(null, new object[] { true, true });
                else
                    compileAll.Invoke(null, new object[paramInfos.Length]);

                // Try to wait for the async task via WaitForCompile
                if (compilerType != null)
                {
                    var waitForCompile = compilerType.GetMethod("WaitForCompile",
                        BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                    waitForCompile?.Invoke(null, null);
                }

                Debug.Log("[UdonSharpCompileRunner] CompileAllCsPrograms() completed");
                return;
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[UdonSharpCompileRunner] CompileAllCsPrograms failed: {e.InnerException?.Message ?? e.Message}");
            }
        }

        Debug.LogWarning("[UdonSharpCompileRunner] All compilation approaches exhausted");
    }

    private static object TryCreateCompileOptions(Type optionsType)
    {
        try
        {
            var opts = Activator.CreateInstance(optionsType);
            // Try to set IsEditorBuild = true
            var editorBuildField = optionsType.GetField("IsEditorBuild") ??
                                   optionsType.GetField("isEditorBuild");
            editorBuildField?.SetValue(opts, true);
            return opts;
        }
        catch
        {
            return null;
        }
    }

    private static string ExtractUasm(UnityEngine.Object asset, Type programAssetType)
    {
        // Primary: UdonSharpEditorCache.GetInstance().GetUASMStr(programAsset)
        var cacheType = GetType("UdonSharp.UdonSharpEditorCache");
        if (cacheType != null)
        {
            var getInstance = cacheType.GetMethod("GetInstance",
                BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic)
                ?? cacheType.GetMethod("get_Instance",
                BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);

            // Also try Instance property
            var instanceProp = cacheType.GetProperty("Instance",
                BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);

            object cacheInstance = null;
            try
            {
                if (getInstance != null)
                    cacheInstance = getInstance.Invoke(null, null);
                else if (instanceProp != null)
                    cacheInstance = instanceProp.GetValue(null);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[UdonSharpCompileRunner] Could not get cache instance: {e.Message}");
            }

            if (cacheInstance != null)
            {
                var getUasmStr = cacheType.GetMethod("GetUASMStr",
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic);
                if (getUasmStr != null)
                {
                    try
                    {
                        var uasm = getUasmStr.Invoke(cacheInstance, new object[] { asset }) as string;
                        if (!string.IsNullOrEmpty(uasm))
                        {
                            Debug.Log("[UdonSharpCompileRunner] Got UASM via EditorCache.GetUASMStr");
                            return uasm;
                        }
                    }
                    catch (Exception e)
                    {
                        Debug.LogWarning($"[UdonSharpCompileRunner] GetUASMStr failed: {e.Message}");
                    }
                }
            }
        }

        // Fallback: udonAssembly field (was empty in probe but worth trying post-compilation)
        var udonAssemblyField = GetFieldIncludingBase(programAssetType, "udonAssembly",
            BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance);
        if (udonAssemblyField != null)
        {
            var value = udonAssemblyField.GetValue(asset) as string;
            if (!string.IsNullOrEmpty(value))
            {
                Debug.Log("[UdonSharpCompileRunner] Got UASM via udonAssembly field");
                return value;
            }
        }

        // Fallback: SerializedObject
        try
        {
            var serialized = new SerializedObject(asset);
            var prop = serialized.FindProperty("udonAssembly");
            if (prop != null && !string.IsNullOrEmpty(prop.stringValue))
            {
                Debug.Log("[UdonSharpCompileRunner] Got UASM via SerializedObject");
                return prop.stringValue;
            }
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[UdonSharpCompileRunner] SerializedObject fallback failed: {e.Message}");
        }

        return null;
    }

    private static void Cleanup(List<string> createdAssets)
    {
        // Delete in reverse order (files before directories)
        for (int i = createdAssets.Count - 1; i >= 0; i--)
        {
            var path = createdAssets[i];
            try
            {
                if (AssetDatabase.DeleteAsset(path))
                    Debug.Log($"[UdonSharpCompileRunner] Cleaned up: {path}");
                else
                    Debug.LogWarning($"[UdonSharpCompileRunner] Could not delete via AssetDatabase: {path}");
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[UdonSharpCompileRunner] Cleanup error for {path}: {e.Message}");
            }
        }
    }

    private static Type GetType(string fullName)
    {
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            try
            {
                var t = asm.GetType(fullName);
                if (t != null) return t;
            }
            catch { }
        }
        return null;
    }

    private static FieldInfo GetFieldIncludingBase(Type type, string name, BindingFlags flags)
    {
        var t = type;
        while (t != null)
        {
            var f = t.GetField(name, flags);
            if (f != null) return f;
            t = t.BaseType;
        }
        return null;
    }
}
