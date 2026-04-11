using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class CopyPropTest : UdonSharpBehaviour
{
    public void Start()
    {
        int a = 5;
        int b = a;
        int c = b;
        int d = c + 1;
        Debug.Log(d);
    }
}
