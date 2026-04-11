using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class ConstantFoldTest : UdonSharpBehaviour
{
    public void Start()
    {
        int a = 2 + 3;
        int b = a * 4;
        int c = 100 / 5;
        int d = b + c;
        Debug.Log(d);
    }
}
