using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class StringConcatTest : UdonSharpBehaviour
{
    public void Start()
    {
        string name = "World";
        string greeting = "Hello, " + name + "! " + "Welcome.";
        Debug.Log(greeting);
    }
}
