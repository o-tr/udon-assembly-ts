using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class LoopUnrollTest : UdonSharpBehaviour
{
    public void Start()
    {
        int sum = 0;
        for (int i = 0; i < 3; i++)
        {
            sum = sum + i;
        }
        Debug.Log(sum);
    }
}
