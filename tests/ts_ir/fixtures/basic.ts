class Demo {
  Start(): void {
    const list: DataList = new DataList();
    list.Add(1);
    const count: number = list.Count;
    Debug.Log(count);
  }
}
