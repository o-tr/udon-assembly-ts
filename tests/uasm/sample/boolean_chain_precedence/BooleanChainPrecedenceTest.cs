using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class BooleanChainPrecedenceTest : UdonSharpBehaviour
{
    public void Start()
    {
        bool a = true;
        bool b = false;
        bool c = true;

        bool result = (a && b) || (c && (a || b));
        Debug.Log(result);
    }
}
