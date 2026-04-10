using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

/// <summary>
/// Phase 0 investigation script: verifies whether UdonSharp C# → UASM generation
/// is feasible in this SDK version.
///
/// Usage (batch mode):
///   Unity -batchmode -nographics -projectPath <path>
///         -executeMethod UdonSharpProbe.Run
///         -probeInputDir <dir>   (directory containing test.cs + probe_input.json)
///         -probeOutputDir <dir>  (where probe_results.json will be written)
///         -logFile <log> -quit
/// </summary>
public static class UdonSharpProbe
{
    #region JSON output types

    [Serializable]
    private class ProbeResults
    {
        public bool udonSharpAvailable;
        public string[] udonSharpTypes;
        public string[] compilerTypes;
        public bool udonAssemblyFieldExists;
        public bool udonAssemblyFieldPopulated;
        public string udonAssemblyContent;
        public bool iUdonProgramObtained;
        public string iUdonProgramDump;
        public string[] errors;
        public string[] log;
    }

    #endregion

    /// <summary>Entry point for Unity batch mode.</summary>
    public static void Run()
    {
        var projectRoot = Path.Combine(Application.dataPath, "..");
        var inputDir = Path.Combine(projectRoot, "ProbeInput");
        var outputDir = Path.Combine(projectRoot, "ProbeOutput");

        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "-probeInputDir") inputDir = args[i + 1];
            if (args[i] == "-probeOutputDir") outputDir = args[i + 1];
        }

        Debug.Log($"[UdonSharpProbe] Input dir: {inputDir}");
        Debug.Log($"[UdonSharpProbe] Output dir: {outputDir}");

        Directory.CreateDirectory(outputDir);

        var errors = new List<string>();
        var log = new List<string>();
        var result = new ProbeResults();

        // Step 1: API exploration via reflection
        log.Add("=== Step 1: API exploration ===");
        try
        {
            ExploreUdonSharpApi(result, log, errors);
        }
        catch (Exception e)
        {
            errors.Add($"API exploration failed: {e.GetType().Name}: {e.Message}");
            Debug.LogException(e);
        }

        // Step 2: Compile test.cs and attempt UASM extraction
        var csSourcePath = Path.Combine(inputDir, "test.cs");
        if (File.Exists(csSourcePath))
        {
            log.Add("=== Step 2: Compilation attempt ===");
            try
            {
                CompileAndExtract(csSourcePath, result, log, errors);
            }
            catch (Exception e)
            {
                errors.Add($"Compilation attempt failed: {e.GetType().Name}: {e.Message}\n{e.StackTrace}");
                Debug.LogException(e);
            }
            finally
            {
                // Cleanup any files copied to Assets/
                CleanupAssets(log, errors);
            }
        }
        else
        {
            log.Add($"No test.cs found at {csSourcePath}, skipping compilation step");
        }

        result.errors = errors.ToArray();
        result.log = log.ToArray();

        var json = JsonUtility.ToJson(result, true);
        var outPath = Path.Combine(outputDir, "probe_results.json");
        File.WriteAllText(outPath, json, Encoding.UTF8);
        Debug.Log($"[UdonSharpProbe] Results written to: {outPath}");
        Debug.Log($"[UdonSharpProbe] udonSharpAvailable={result.udonSharpAvailable}, " +
                  $"udonAssemblyFieldExists={result.udonAssemblyFieldExists}, " +
                  $"udonAssemblyFieldPopulated={result.udonAssemblyFieldPopulated}, " +
                  $"iUdonProgramObtained={result.iUdonProgramObtained}");

        EditorApplication.Exit(0);
    }

    private static void ExploreUdonSharpApi(ProbeResults result, List<string> log, List<string> errors)
    {
        // Find all UdonSharp-related types across all loaded assemblies
        var udonSharpTypes = new List<string>();
        var compilerTypes = new List<string>();

        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            try
            {
                foreach (var type in asm.GetTypes())
                {
                    var ns = type.Namespace ?? "";
                    if (ns.StartsWith("UdonSharp") || type.Name.Contains("UdonSharp"))
                    {
                        udonSharpTypes.Add($"{asm.GetName().Name}: {type.FullName}");
                        if (type.Name.Contains("Compiler") || type.Name.Contains("Assembly") ||
                            type.Name.Contains("Program") || type.Name.Contains("Editor"))
                        {
                            compilerTypes.Add($"{asm.GetName().Name}: {type.FullName}");

                            // Log methods on interesting types
                            try
                            {
                                var methods = type.GetMethods(BindingFlags.Public | BindingFlags.Static |
                                                              BindingFlags.Instance | BindingFlags.NonPublic)
                                    .Select(m => $"  {(m.IsStatic ? "static " : "")}{m.Name}({string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name))})")
                                    .ToArray();
                                log.Add($"Type {type.FullName} methods:");
                                foreach (var m in methods) log.Add(m);

                                // Check fields
                                var fields = type.GetFields(BindingFlags.Public | BindingFlags.Instance |
                                                            BindingFlags.NonPublic | BindingFlags.Static)
                                    .Select(f => $"  [{(f.IsPublic ? "pub" : "prv")}] {f.FieldType.Name} {f.Name}")
                                    .ToArray();
                                if (fields.Length > 0)
                                {
                                    log.Add($"Type {type.FullName} fields:");
                                    foreach (var f in fields) log.Add(f);
                                }
                            }
                            catch (Exception ex)
                            {
                                log.Add($"  (could not reflect methods: {ex.Message})");
                            }
                        }
                    }
                }
            }
            catch
            {
                // Some assemblies may throw on GetTypes(); skip them
            }
        }

        result.udonSharpAvailable = udonSharpTypes.Count > 0;
        result.udonSharpTypes = udonSharpTypes.ToArray();
        result.compilerTypes = compilerTypes.ToArray();

        log.Add($"Found {udonSharpTypes.Count} UdonSharp-related types, {compilerTypes.Count} compiler-related");
    }

    private static void CompileAndExtract(string csSourcePath, ProbeResults result, List<string> log, List<string> errors)
    {
        // Copy the .cs file into Assets so Unity can discover it as a MonoScript
        const string inputSubdir = "UdonSharpProbeInput";
        var assetsInputDir = Path.Combine(Application.dataPath, inputSubdir);
        Directory.CreateDirectory(assetsInputDir);

        var destPath = Path.Combine(assetsInputDir, Path.GetFileName(csSourcePath));
        File.Copy(csSourcePath, destPath, overwrite: true);
        log.Add($"Copied {csSourcePath} -> {destPath}");

        // Force Unity to recognize the new file
        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
        log.Add("AssetDatabase.Refresh() completed");

        // Attempt to find the MonoScript
        var assetRelPath = $"Assets/{inputSubdir}/{Path.GetFileName(csSourcePath)}";
        var monoScript = AssetDatabase.LoadAssetAtPath<MonoScript>(assetRelPath);
        if (monoScript == null)
        {
            errors.Add($"MonoScript not found at {assetRelPath}");
            log.Add("MonoScript not found — UdonSharp may not have compiled this file");
            AttemptProgramAssetSearch(result, log, errors);
            return;
        }

        log.Add($"MonoScript found: {monoScript.name} (class: {monoScript.GetClass()?.FullName ?? "null"})");

        // Search for any UdonSharpProgramAsset created by UdonSharp for this script
        AttemptProgramAssetSearch(result, log, errors);

        // Also try to find UdonSharpProgramAsset type and use compiler directly
        AttemptDirectCompilation(monoScript, result, log, errors);
    }

    private static void AttemptProgramAssetSearch(ProbeResults result, List<string> log, List<string> errors)
    {
        // Find UdonSharpProgramAsset type
        Type programAssetType = null;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            try
            {
                programAssetType = asm.GetType("UdonSharp.UdonSharpProgramAsset");
                if (programAssetType != null) break;
            }
            catch { }
        }

        if (programAssetType == null)
        {
            log.Add("UdonSharpProgramAsset type not found in any assembly");
            return;
        }

        log.Add($"UdonSharpProgramAsset type found in assembly: {programAssetType.Assembly.GetName().Name}");

        // Check if UdonSharpProgramAsset has udonAssembly field
        var udonAssemblyField = programAssetType.GetField("udonAssembly",
            BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance);
        if (udonAssemblyField == null)
        {
            // Also check base types
            var baseType = programAssetType.BaseType;
            while (baseType != null && udonAssemblyField == null)
            {
                udonAssemblyField = baseType.GetField("udonAssembly",
                    BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance);
                if (udonAssemblyField != null)
                    log.Add($"udonAssembly field found on base type: {baseType.FullName}");
                baseType = baseType.BaseType;
            }
        }
        else
        {
            log.Add("udonAssembly field found on UdonSharpProgramAsset itself");
        }

        result.udonAssemblyFieldExists = udonAssemblyField != null;

        if (udonAssemblyField == null)
        {
            log.Add("udonAssembly field NOT found (neither on UdonSharpProgramAsset nor its base types)");
        }

        // Find existing UdonSharpProgramAsset instances in the project
        var guids = AssetDatabase.FindAssets($"t:{programAssetType.Name}");
        log.Add($"Found {guids.Length} UdonSharpProgramAsset(s) in project");

        foreach (var guid in guids)
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            var asset = AssetDatabase.LoadAssetAtPath(path, programAssetType);
            if (asset == null) continue;

            log.Add($"  Asset: {path}");

            // Try reading udonAssembly via reflection
            if (udonAssemblyField != null)
            {
                try
                {
                    var value = udonAssemblyField.GetValue(asset) as string;
                    log.Add($"  udonAssembly field value: {(string.IsNullOrEmpty(value) ? "(empty)" : $"{value.Length} chars")}");
                    if (!string.IsNullOrEmpty(value))
                    {
                        result.udonAssemblyFieldPopulated = true;
                        result.udonAssemblyContent = value;
                    }
                }
                catch (Exception ex)
                {
                    log.Add($"  Could not read udonAssembly via reflection: {ex.Message}");
                }

                // Also try via SerializedObject
                try
                {
                    var serialized = new SerializedObject(asset);
                    var prop = serialized.FindProperty("udonAssembly");
                    if (prop != null)
                    {
                        var sv = prop.stringValue;
                        log.Add($"  udonAssembly via SerializedObject: {(string.IsNullOrEmpty(sv) ? "(empty)" : $"{sv.Length} chars")}");
                        if (!string.IsNullOrEmpty(sv) && !result.udonAssemblyFieldPopulated)
                        {
                            result.udonAssemblyFieldPopulated = true;
                            result.udonAssemblyContent = sv;
                        }
                    }
                    else
                    {
                        log.Add("  SerializedObject.FindProperty('udonAssembly') returned null");
                        // Log all property names
                        var iter = serialized.GetIterator();
                        var propNames = new List<string>();
                        if (iter.NextVisible(true))
                        {
                            do { propNames.Add(iter.propertyPath); }
                            while (iter.NextVisible(false));
                        }
                        log.Add($"  Available properties: {string.Join(", ", propNames.Take(20))}");
                    }
                }
                catch (Exception ex)
                {
                    log.Add($"  SerializedObject access failed: {ex.Message}");
                }
            }

            // Try to get IUdonProgram from the asset
            TryGetIUdonProgram(asset, programAssetType, result, log, errors);
        }
    }

    private static void TryGetIUdonProgram(
        UnityEngine.Object asset, Type programAssetType,
        ProbeResults result, List<string> log, List<string> errors)
    {
        // Look for a method or property that returns IUdonProgram
        var iUdonProgramType = AppDomain.CurrentDomain.GetAssemblies()
            .SelectMany(a => { try { return a.GetTypes(); } catch { return Array.Empty<Type>(); } })
            .FirstOrDefault(t => t.Name == "IUdonProgram");

        if (iUdonProgramType == null)
        {
            log.Add("  IUdonProgram type not found");
            return;
        }

        // Check for GetProgram(), SerializePublicVariables(), etc.
        var methods = programAssetType.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic);
        foreach (var method in methods)
        {
            if (iUdonProgramType.IsAssignableFrom(method.ReturnType))
            {
                log.Add($"  Found method returning IUdonProgram: {method.Name}");
                try
                {
                    var program = method.Invoke(asset, null);
                    if (program != null)
                    {
                        result.iUdonProgramObtained = true;
                        result.iUdonProgramDump = DumpIUdonProgram(program, iUdonProgramType, log);
                    }
                }
                catch (Exception ex)
                {
                    log.Add($"  Calling {method.Name} failed: {ex.Message}");
                }
            }
        }

        // Also check fields
        var fields = programAssetType.GetFields(BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic);
        foreach (var field in fields)
        {
            if (iUdonProgramType.IsAssignableFrom(field.FieldType))
            {
                log.Add($"  Found field of IUdonProgram type: {field.Name}");
                try
                {
                    var program = field.GetValue(asset);
                    if (program != null && !result.iUdonProgramObtained)
                    {
                        result.iUdonProgramObtained = true;
                        result.iUdonProgramDump = DumpIUdonProgram(program, iUdonProgramType, log);
                    }
                }
                catch (Exception ex)
                {
                    log.Add($"  Reading field {field.Name} failed: {ex.Message}");
                }
            }
        }
    }

    private static string DumpIUdonProgram(object program, Type iUdonProgramType, List<string> log)
    {
        var sb = new StringBuilder();
        sb.AppendLine("[IUdonProgram dump]");

        // Try to get SymbolTable, EntryPoints, ByteCode via reflection
        foreach (var prop in iUdonProgramType.GetProperties())
        {
            try
            {
                var value = prop.GetValue(program);
                if (value is byte[] bytes)
                    sb.AppendLine($"  {prop.Name}: byte[{bytes.Length}]");
                else
                    sb.AppendLine($"  {prop.Name}: {value?.GetType()?.Name ?? "null"} = {value}");
            }
            catch (Exception ex)
            {
                sb.AppendLine($"  {prop.Name}: (error: {ex.Message})");
            }
        }

        var symbolTable = iUdonProgramType.GetProperty("SymbolTable")?.GetValue(program);
        if (symbolTable != null)
        {
            log.Add($"SymbolTable type: {symbolTable.GetType().FullName}");
            // Try GetSymbols()
            var getSymbols = symbolTable.GetType().GetMethod("GetSymbols",
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic);
            if (getSymbols != null)
            {
                try
                {
                    var symbols = getSymbols.Invoke(symbolTable, null) as IEnumerable<object>;
                    if (symbols != null)
                    {
                        sb.AppendLine("  SymbolTable symbols:");
                        foreach (var sym in symbols.Take(20))
                            sb.AppendLine($"    {sym}");
                    }
                }
                catch (Exception ex)
                {
                    sb.AppendLine($"  GetSymbols() error: {ex.Message}");
                }
            }
        }

        var entryPoints = iUdonProgramType.GetProperty("EntryPoints")?.GetValue(program);
        if (entryPoints != null)
        {
            var getExported = entryPoints.GetType().GetMethod("GetExportedSymbols",
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.NonPublic);
            if (getExported != null)
            {
                try
                {
                    var symbols = getExported.Invoke(entryPoints, null) as IEnumerable<object>;
                    if (symbols != null)
                        sb.AppendLine($"  EntryPoints: {string.Join(", ", symbols)}");
                }
                catch { }
            }
        }

        return sb.ToString();
    }

    private static void AttemptDirectCompilation(
        MonoScript monoScript, ProbeResults result, List<string> log, List<string> errors)
    {
        log.Add("=== Step 2b: Attempting direct compilation via UdonSharp APIs ===");

        // Look for UdonSharpEditorUtility or UdonSharpCompilerV1
        Type compilerType = null;
        Type editorUtilType = null;

        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            try
            {
                foreach (var type in asm.GetTypes())
                {
                    if (type.FullName == "UdonSharpEditor.UdonSharpEditorUtility")
                        editorUtilType = type;
                    if (type.FullName == "UdonSharp.Compiler.UdonSharpCompilerV1" ||
                        type.Name == "UdonSharpCompilerV1")
                        compilerType = type;
                }
            }
            catch { }
        }

        if (editorUtilType != null)
        {
            log.Add($"UdonSharpEditorUtility found: {editorUtilType.Assembly.GetName().Name}");

            // Try GetUdonSharpProgramAsset(MonoScript)
            var getAssetMethod = editorUtilType.GetMethod("GetUdonSharpProgramAsset",
                BindingFlags.Public | BindingFlags.Static,
                null, new[] { typeof(MonoScript) }, null);

            if (getAssetMethod != null)
            {
                log.Add("Found GetUdonSharpProgramAsset(MonoScript)");
                try
                {
                    var asset = getAssetMethod.Invoke(null, new object[] { monoScript });
                    log.Add($"GetUdonSharpProgramAsset result: {asset?.GetType()?.Name ?? "null"}");
                }
                catch (Exception ex)
                {
                    log.Add($"GetUdonSharpProgramAsset failed: {ex.Message}");
                }
            }

            // List all static methods
            var staticMethods = editorUtilType.GetMethods(BindingFlags.Public | BindingFlags.Static);
            log.Add($"UdonSharpEditorUtility static methods: {string.Join(", ", staticMethods.Select(m => m.Name))}");
        }
        else
        {
            log.Add("UdonSharpEditorUtility not found");
        }

        if (compilerType != null)
        {
            log.Add($"UdonSharpCompilerV1 found: {compilerType.Assembly.GetName().Name}");
            var staticMethods = compilerType.GetMethods(BindingFlags.Public | BindingFlags.Static);
            log.Add($"UdonSharpCompilerV1 static methods: {string.Join(", ", staticMethods.Select(m => m.Name))}");
        }
        else
        {
            log.Add("UdonSharpCompilerV1 not found");
        }
    }

    private static void CleanupAssets(List<string> log, List<string> errors)
    {
        const string inputSubdir = "UdonSharpProbeInput";
        var assetsInputDir = Path.Combine(Application.dataPath, inputSubdir);
        if (Directory.Exists(assetsInputDir))
        {
            try
            {
                // Use AssetDatabase to delete properly (handles .meta files)
                AssetDatabase.DeleteAsset($"Assets/{inputSubdir}");
                log.Add($"Cleaned up Assets/{inputSubdir}");
            }
            catch (Exception ex)
            {
                errors.Add($"Cleanup failed: {ex.Message}");
                // Fallback to direct delete
                try
                {
                    Directory.Delete(assetsInputDir, recursive: true);
                    var metaPath = assetsInputDir + ".meta";
                    if (File.Exists(metaPath)) File.Delete(metaPath);
                }
                catch { }
            }
        }
    }
}
