// O N do Nimbus. O PNG já vem com fundo azul próprio, então funciona igual nos
// dois temas; o borderRadius proporcional dá o arredondado de ícone de app.
export default function Logo({ size = 20 }) {
  return (
    <img
      src="/nimbus-icon.png"
      alt="Nimbus"
      width={size}
      height={size}
      style={{ borderRadius: Math.round(size * 0.22), display: "block", flexShrink: 0 }}
    />
  );
}
