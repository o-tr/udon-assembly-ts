using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class GvnPreTest : UdonSharpBehaviour
{
    public void Start()
    {
        int x = 10;
        int y = 20;
        int a = x + y;
        int b = x + y;
        Debug.Log(a);
        Debug.Log(b);
    }
}
