using VRC.Udon.Common;
using VRC.Udon.Common.Interfaces;

namespace jp.ootr.TASM.Editor
{
    internal class HeapFactory : IUdonHeapFactory
    {
        public uint FactoryHeapSize { get; set; }

        public IUdonHeap ConstructUdonHeap()
        {
            return new UdonHeap(FactoryHeapSize);
        }

        public IUdonHeap ConstructUdonHeap(uint heapSize)
        {
            return new UdonHeap(heapSize);
        }
    }
}
