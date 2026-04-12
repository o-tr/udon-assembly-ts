using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class ArrayReassignThenReadTest : UdonSharpBehaviour
{
    public void Start()
    {
        int[] values = new int[] { 2, 4, 6 };
        values[0] = values[1] + 1;
        values[2] = values[0] + values[1];

        Debug.Log(values[0]);
        Debug.Log(values[2]);
    }
}
