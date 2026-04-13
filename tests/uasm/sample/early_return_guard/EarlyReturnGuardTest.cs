using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class EarlyReturnGuardTest : UdonSharpBehaviour
{
    private bool isReady = false;

    public void Start()
    {
        if (!isReady)
        {
            Debug.Log("skip");
            return;
        }

        Debug.Log("run");
    }
}
