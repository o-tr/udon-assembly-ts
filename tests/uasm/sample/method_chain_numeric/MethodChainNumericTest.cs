using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class MethodChainNumericTest : UdonSharpBehaviour
{
    private int AddOne(int value)
    {
        return value + 1;
    }

    private int MultiplyByTwo(int value)
    {
        return value * 2;
    }

    private int Clamp(int value, int min, int max)
    {
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    public void Start()
    {
        int result = Clamp(MultiplyByTwo(AddOne(5)), 0, 20);
        Debug.Log(result);
    }
}
