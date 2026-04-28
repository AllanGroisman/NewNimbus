const colorMap = {
  green: { bg: "#EAF3DE", text: "#3B6D11" },
  red: { bg: "#FCEBEB", text: "#A32D2D" },
  amber: { bg: "#FAEEDA", text: "#854F0B" },
  blue: { bg: "#E6F1FB", text: "#185FA5" },
  teal: { bg: "#E1F5EE", text: "#0F6E56" },
  gray: { bg: "#F1EFE8", text: "#5F5E5A" },
  purple: { bg: "#EEEDFE", text: "#3C3489" },
};

export default function Badge({ color, children }) {
  const c = colorMap[color] || colorMap.gray;
  return (
    <span style={{ background: c.bg, color: c.text, fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 6, display: "inline-block", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}
