using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class LoopBreakContinueTest : UdonSharpBehaviour
{
    public void Start()
    {
        int sum = 0;
        for (int i = 0; i < 8; i++)
        {
            if (i == 2)
            {
                continue;
            }
            if (i == 6)
            {
                break;
            }
            sum += i;
        }

        Debug.Log(sum);
    }
}
