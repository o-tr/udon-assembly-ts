using UdonSharp;
using UnityEngine;

[UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public class RealisticTest : UdonSharpBehaviour
{
    private int score;
    private int highScore;
    private bool isPlaying;

    public void Start()
    {
        score = 0;
        highScore = 100;
        isPlaying = true;
    }

    public void AddScore(int points)
    {
        if (!isPlaying) return;

        score = score + points;
        if (score > highScore)
        {
            highScore = score;
            Debug.Log("New high score!");
        }

        string msg = "Score: " + score.ToString();
        Debug.Log(msg);
    }

    public void ResetGame()
    {
        score = 0;
        isPlaying = true;
        Debug.Log("Game reset");
    }

    public int GetScore()
    {
        return score;
    }

    public int GetHighScore()
    {
        return highScore;
    }
}
