using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class IfElseChainTest : UdonSharpBehaviour
{
    public void Start()
    {
        int x = 5;
        int result = 0;
        if (x > 10)
        {
            result = 1;
        }
        else if (x > 3)
        {
            result = 2;
        }
        else
        {
            result = 3;
        }
        Debug.Log(result);
    }
}
