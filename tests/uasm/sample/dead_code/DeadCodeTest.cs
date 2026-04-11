using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class DeadCodeTest : UdonSharpBehaviour
{
    public void Start()
    {
        int x = 10;
        int y = 20;
        int z = x + y;
        int w = x * 2;
        Debug.Log(w);
        return;
        Debug.Log("unreachable");
    }
}
