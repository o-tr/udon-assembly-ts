using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class NestedIfMergeTest : UdonSharpBehaviour
{
    public void Start()
    {
        int score = 9;
        int lives = 1;

        string result = "";
        if (score > 10)
        {
            result = "clear";
        }
        else if (lives > 0)
        {
            result = "retry";
        }
        else
        {
            result = "fail";
        }

        Debug.Log(result);
    }
}
