using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class NullCoalescingStringTest : UdonSharpBehaviour
{
    private string GetNullable()
    {
        return null;
    }

    private string GetPresent()
    {
        return "ready";
    }

    public void Start()
    {
        string first = GetNullable() ?? "fallback";
        string second = GetPresent() ?? "fallback";
        Debug.Log(first);
        Debug.Log(second);
    }
}
