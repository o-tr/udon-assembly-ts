using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class FibonacciTest : UdonSharpBehaviour
{
    public void Start()
    {
        int a = 0;
        int b = 1;
        for (int i = 0; i < 10; i++)
        {
            Debug.Log(a);
            int temp = a + b;
            a = b;
            b = temp;
        }
    }
}
