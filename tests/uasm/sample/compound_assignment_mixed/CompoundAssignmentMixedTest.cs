using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class CompoundAssignmentMixedTest : UdonSharpBehaviour
{
    public void Start()
    {
        int total = 10;
        float ratio = 1.5f;

        total += 4;
        ratio *= 2f;
        ratio += total;

        Debug.Log(total);
        Debug.Log(ratio);
    }
}
