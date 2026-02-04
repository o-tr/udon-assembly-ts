using System;
using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class UdonSharpTest : UdonSharpBehaviour
{
    public void Start()
    {
        Debug.Log("hello udon-sharp");
    }
}
