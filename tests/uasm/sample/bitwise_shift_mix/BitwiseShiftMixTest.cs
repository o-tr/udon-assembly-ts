using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class BitwiseShiftMixTest : UdonSharpBehaviour
{
    public void Start()
    {
        int value = 42;
        int mask = 15;

        int andValue = value & mask;
        int leftShift = andValue << 1;
        int rightShift = leftShift >> 2;

        Debug.Log(andValue);
        Debug.Log(leftShift);
        Debug.Log(rightShift);
    }
}
