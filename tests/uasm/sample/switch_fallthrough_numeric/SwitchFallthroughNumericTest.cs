using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class SwitchFallthroughNumericTest : UdonSharpBehaviour
{
    public void Start()
    {
        int value = 2;
        string label = "";

        switch (value)
        {
            case 0:
                label = "zero";
                break;
            case 1:
            case 2:
                label = "small";
                break;
            default:
                label = "other";
                break;
        }

        Debug.Log(label);
    }
}
