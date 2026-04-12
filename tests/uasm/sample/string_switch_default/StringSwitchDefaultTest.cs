using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class StringSwitchDefaultTest : UdonSharpBehaviour
{
    public void Start()
    {
        string command = "pause";
        string status = "";

        switch (command)
        {
            case "start":
                status = "started";
                break;
            case "stop":
                status = "stopped";
                break;
            default:
                status = "unknown";
                break;
        }

        Debug.Log(status);
    }
}
