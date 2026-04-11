using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class BooleanSimpTest : UdonSharpBehaviour
{
    public void Start()
    {
        bool flag = true;
        bool a = flag && true;
        bool b = flag || false;
        bool c = !(flag == false);
        Debug.Log(a);
        Debug.Log(b);
        Debug.Log(c);
    }
}
