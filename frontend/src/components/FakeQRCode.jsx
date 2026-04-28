export default function FakeQRCode() {
  const size = 21;
  const pattern = [];
  for (let i = 0; i < size; i++) {
    const row = [];
    for (let j = 0; j < size; j++) {
      const isCorner = (i < 7 && j < 7) || (i < 7 && j >= size - 7) || (i >= size - 7 && j < 7);
      if (isCorner) {
        const ci = i >= size - 7 ? i - (size - 7) : i;
        const cj = j >= size - 7 ? j - (size - 7) : j;
        const outer = ci === 0 || ci === 6 || cj === 0 || cj === 6;
        const inner = ci >= 2 && ci <= 4 && cj >= 2 && cj <= 4;
        row.push(outer || inner);
      } else {
        row.push((i * 7 + j * 13 + i * j) % 3 === 0);
      }
    }
    pattern.push(row);
  }
  return (
    <div style={{ display: "inline-grid", gridTemplateColumns: `repeat(${size}, 1fr)`, gap: 0, width: 180, height: 180, background: "#fff", padding: 10, borderRadius: 8 }}>
      {pattern.flatMap((row, i) => row.map((filled, j) => (
        <div key={`${i}-${j}`} style={{ background: filled ? "#000" : "#fff", aspectRatio: "1" }} />
      )))}
    </div>
  );
}
