using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class LicmTest : UdonSharpBehaviour
{
    public void Start()
    {
        int baseVal = 10;
        int mult = 3;
        int sum = 0;
        for (int i = 0; i < 5; i++)
        {
            int invariant = baseVal * mult;
            sum = sum + invariant;
        }
        Debug.Log(sum);
    }
}
