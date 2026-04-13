using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class ForLoopAccumulateFloatTest : UdonSharpBehaviour
{
    public void Start()
    {
        float sum = 0f;
        for (int i = 0; i < 4; i++)
        {
            sum += i * 0.5f;
        }
        Debug.Log(sum);
    }
}
