using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class VectorUpdateTest : UdonSharpBehaviour
{
    private Vector3 position;

    public void Start()
    {
        position = new Vector3(1.0f, 2.0f, 3.0f);
        position = new Vector3(
            position.x + 1.0f,
            position.y + 2.0f,
            position.z + 3.0f
        );
        Debug.Log(position);
    }
}
