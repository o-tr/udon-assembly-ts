using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class ArrayIndexMutationTest : UdonSharpBehaviour
{
    public void Start()
    {
        int[] values = new int[] { 1, 2, 3, 4 };
        values[1] = values[0] + values[2];
        values[3] = values[1] * 2;

        Debug.Log(values[1]);
        Debug.Log(values[3]);
    }
}
