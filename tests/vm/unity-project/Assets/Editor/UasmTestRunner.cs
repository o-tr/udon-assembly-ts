using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEngine;
using VRC.Udon.Common.Interfaces;
using VRC.Udon.Editor;
using VRC.Udon.Editor.ProgramSources;

public static class UasmTestRunner
{
    #region JSON Serializable Types

    [Serializable]
    private class TestDefinitions
    {
        public TestDefinitionEntry[] tests;
    }

    [Serializable]
    private class TestDefinitionEntry
    {
        public string name;
        public string uasmFile;
        public string entryPoint;
        public string[] expectedLogs;
        public bool expectError;
    }

    [Serializable]
    private class TestResults
    {
        public TestResultEntry[] results;
        public TestSummary summary;
    }

    [Serializable]
    private class TestResultEntry
    {
        public string name;
        public bool passed;
        public string[] capturedLogs;
        public string[] expectedLogs;
        public string error;
    }

    [Serializable]
    private class TestSummary
    {
        public int total;
        public int passed;
        public int failed;
    }

    #endregion

    /// <summary>
    /// Entry point for batch mode execution.
    /// Usage: Unity -batchmode -executeMethod UasmTestRunner.Run
    ///        [-uasmTestInputDir path] [-uasmTestOutputDir path]
    ///        -logFile /tmp/unity.log -quit
    /// </summary>
    public static void Run()
    {
        // Force invariant culture so float.ToString() etc. always use '.' as decimal separator
        System.Threading.Thread.CurrentThread.CurrentCulture = CultureInfo.InvariantCulture;

        var projectRoot = Path.Combine(Application.dataPath, "..");
        var inputDir = Path.Combine(projectRoot, "TestInput");
        var outputDir = Path.Combine(projectRoot, "TestResults");

        // Parse command line arguments
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "-uasmTestInputDir") inputDir = args[i + 1];
            if (args[i] == "-uasmTestOutputDir") outputDir = args[i + 1];
        }

        Debug.Log($"[UasmTestRunner] Input dir: {inputDir}");
        Debug.Log($"[UasmTestRunner] Output dir: {outputDir}");

        // Read test definitions
        var definitionsPath = Path.Combine(inputDir, "test_definitions.json");
        if (!File.Exists(definitionsPath))
        {
            Debug.LogError($"[UasmTestRunner] test_definitions.json not found at {definitionsPath}");
            EditorApplication.Exit(1);
            return;
        }

        var definitionsJson = File.ReadAllText(definitionsPath);
        var definitions = JsonUtility.FromJson<TestDefinitions>(definitionsJson);

        if (definitions?.tests == null || definitions.tests.Length == 0)
        {
            Debug.LogError("[UasmTestRunner] No test cases found in test_definitions.json");
            EditorApplication.Exit(1);
            return;
        }

        Debug.Log($"[UasmTestRunner] Running {definitions.tests.Length} test(s)...");

        // Run all tests
        var resultEntries = new List<TestResultEntry>();
        int passedCount = 0;

        foreach (var testDef in definitions.tests)
        {
            var result = RunTestCase(inputDir, testDef);
            resultEntries.Add(result);
            if (result.passed) passedCount++;

            var status = result.passed ? "PASSED" : "FAILED";
            Debug.Log($"[UasmTestRunner] {testDef.name}: {status}");
            if (!string.IsNullOrEmpty(result.error))
            {
                Debug.LogError($"[UasmTestRunner]   Error: {result.error}");
            }
        }

        // Write results
        Directory.CreateDirectory(outputDir);
        var testResults = new TestResults
        {
            results = resultEntries.ToArray(),
            summary = new TestSummary
            {
                total = definitions.tests.Length,
                passed = passedCount,
                failed = definitions.tests.Length - passedCount
            }
        };

        var resultJson = JsonUtility.ToJson(testResults, true);
        var resultPath = Path.Combine(outputDir, "test_results.json");
        File.WriteAllText(resultPath, resultJson);
        Debug.Log($"[UasmTestRunner] Results written to: {resultPath}");
        Debug.Log($"[UasmTestRunner] Summary: {passedCount}/{definitions.tests.Length} passed");

        EditorApplication.Exit(passedCount == definitions.tests.Length ? 0 : 1);
    }

    private static TestResultEntry RunTestCase(string inputDir, TestDefinitionEntry testDef)
    {
        var result = new TestResultEntry
        {
            name = testDef.name,
            expectedLogs = testDef.expectedLogs ?? Array.Empty<string>(),
            capturedLogs = Array.Empty<string>(),
            error = "",
            passed = false
        };

        var capturedLogs = new List<string>();
        var capturedErrors = new List<string>();

        // Log capture handler - capture LogType.Log and errors for diagnostics
        Application.LogCallback logHandler = (message, stackTrace, type) =>
        {
            if (type == LogType.Log && !message.StartsWith("[UasmTestRunner]"))
            {
                capturedLogs.Add(message);
            }
            else if (type == LogType.Error || type == LogType.Exception || type == LogType.Warning)
            {
                capturedErrors.Add($"[{type}] {message}");
            }
        };

        IUdonVM vm = null;
        try
        {
            // Read .uasm file
            var uasmPath = Path.Combine(inputDir, testDef.uasmFile);
            if (!File.Exists(uasmPath))
            {
                result.error = $"UASM file not found: {uasmPath}";
                return result;
            }

            var uasmText = File.ReadAllText(uasmPath);

            // Assemble (with dynamic heap sizing for large programs)
            IUdonProgram program;
            try
            {
                uint heapSize = TASMProgramAsset.CalculateHeapSize(uasmText);
                program = TASMProgramAsset.AssembleWithHeapSize(uasmText, heapSize);
            }
            catch (Exception e)
            {
                if (testDef.expectError)
                {
                    result.passed = true;
                    result.error = $"Expected error: {e.Message}";
                    return result;
                }
                result.error = $"Assembly failed: {e.Message}";
                return result;
            }

            if (program == null)
            {
                if (testDef.expectError)
                {
                    result.passed = true;
                    result.error = "Expected error: Assemble() returned null";
                    return result;
                }
                result.error = "Assemble() returned null";
                return result;
            }

            // Construct VM (fresh instance per test)
            vm = UdonEditorManager.Instance.ConstructUdonVM();
            if (vm == null)
            {
                result.error = "ConstructUdonVM() returned null";
                return result;
            }

            vm.LoadProgram(program);

            // Find entry point
            var entryPoint = string.IsNullOrEmpty(testDef.entryPoint) ? "_start" : testDef.entryPoint;
            if (!program.EntryPoints.HasExportedSymbol(entryPoint))
            {
                result.error = $"Entry point '{entryPoint}' not found. Available: {string.Join(", ", program.EntryPoints.GetExportedSymbols())}";
                return result;
            }

            uint address = program.EntryPoints.GetAddressFromSymbol(entryPoint);
            vm.SetProgramCounter(address);

            // Register log capture and execute
            Application.logMessageReceived += logHandler;
            try
            {
                // NOTE: Interpret() is a blocking call with no timeout.
                // Test cases must be loop-terminating; an infinite loop will block
                // until the outer execFileSync timeout kills the Unity process.
                // In batch mode, a single Interpret() call runs the program to
                // completion and returns 0 on success. A non-zero return indicates
                // an error (verified empirically; the SDK does not document the
                // exact semantics of the return value).
                uint execResult = vm.Interpret();
                if (execResult != 0)
                {
                    if (testDef.expectError)
                    {
                        result.passed = true;
                        result.capturedLogs = capturedLogs.ToArray();
                        result.error = $"Expected error: VM returned {execResult}";
                        return result;
                    }
                    result.error = $"VM execution returned non-zero: {execResult}{FormatVmErrors(capturedErrors)}";
                    result.capturedLogs = capturedLogs.ToArray();
                    return result;
                }
            }
            finally
            {
                Application.logMessageReceived -= logHandler;
            }

            result.capturedLogs = capturedLogs.ToArray();

            // If we expected an error but didn't get one
            if (testDef.expectError)
            {
                result.error = "Expected an error but execution succeeded";
                return result;
            }

            // Compare logs
            if (capturedLogs.Count != result.expectedLogs.Length)
            {
                result.error = $"Log count mismatch: expected {result.expectedLogs.Length}, got {capturedLogs.Count}{FormatVmErrors(capturedErrors)}";
                return result;
            }

            for (int i = 0; i < result.expectedLogs.Length; i++)
            {
                if (capturedLogs[i] != result.expectedLogs[i])
                {
                    result.error = $"Log[{i}]: expected '{result.expectedLogs[i]}', got '{capturedLogs[i]}'{FormatVmErrors(capturedErrors)}";
                    return result;
                }
            }

            result.passed = true;
        }
        catch (Exception e)
        {
            var errorSuffix = FormatVmErrors(capturedErrors);
            if (testDef.expectError)
            {
                result.passed = true;
                result.error = $"Expected error: {e.GetType().Name}: {e.Message}{errorSuffix}";
                result.capturedLogs = capturedLogs.ToArray();
                return result;
            }
            var innerMsg = e.InnerException != null ? $"\n  Inner: {e.InnerException.GetType().Name}: {e.InnerException.Message}" : "";
            var pcInfo = vm != null ? $"\n  PC: 0x{vm.GetProgramCounter():X8}" : "";
            result.error = $"{e.GetType().Name}: {e.Message}{innerMsg}{pcInfo}\n{e.StackTrace}{errorSuffix}";
            result.capturedLogs = capturedLogs.ToArray();
        }

        return result;
    }

    private static string FormatVmErrors(List<string> capturedErrors)
    {
        return capturedErrors.Count > 0
            ? "\nVM diagnostics:\n" + string.Join("\n", capturedErrors)
            : "";
    }

}
