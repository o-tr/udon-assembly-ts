using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class NestedTernaryBranchTest : UdonSharpBehaviour
{
    public void Start()
    {
        int score = 7;
        int streak = 2;
        string rank = score > 10 ? "high" : score > 5 ? (streak > 3 ? "mid-plus" : "mid") : "low";
        Debug.Log(rank);
    }
}
