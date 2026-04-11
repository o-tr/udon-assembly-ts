using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class TailMergeTest : UdonSharpBehaviour
{
    private int mode;

    public void Start()
    {
        mode = 1;
        if (mode == 1)
        {
            Debug.Log("mode one");
        }
        else if (mode == 2)
        {
            Debug.Log("mode two");
        }
        else
        {
            Debug.Log("other");
        }
    }
}
