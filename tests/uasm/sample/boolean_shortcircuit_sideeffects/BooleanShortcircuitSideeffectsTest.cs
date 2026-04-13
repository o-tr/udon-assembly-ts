using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class BooleanShortcircuitSideeffectsTest : UdonSharpBehaviour
{
    private int counter = 0;

    private bool BumpTrue()
    {
        counter += 1;
        return true;
    }

    private bool BumpFalse()
    {
        counter += 1;
        return false;
    }

    public void Start()
    {
        bool first = BumpFalse() && BumpTrue();
        bool second = BumpTrue() || BumpFalse();

        Debug.Log(counter);
        Debug.Log(first);
        Debug.Log(second);
    }
}
