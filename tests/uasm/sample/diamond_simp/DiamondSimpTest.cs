using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class DiamondSimpTest : UdonSharpBehaviour
{
    private int score;

    public void Start()
    {
        score = 75;
        bool passed = score >= 60 ? true : false;
        bool failed = score < 60 ? true : false;
        Debug.Log(passed);
        Debug.Log(failed);
    }
}
