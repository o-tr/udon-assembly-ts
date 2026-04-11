using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class AlgebraicSimpTest : UdonSharpBehaviour
{
    private int value;

    public void Start()
    {
        value = 10;
        int a = value + 0;
        int b = value * 1;
        int c = value - 0;
        int d = value * 0;
        Debug.Log(a);
        Debug.Log(b);
        Debug.Log(c);
        Debug.Log(d);
    }
}
