// O que dizer quando a extensão do coletor não respondeu.
//
// Sem ela o botão "colher no meu Chrome" simplesmente sumia, e sumir sem explicação
// é pior do que não existir. Vive fora das páginas porque duas dizem a mesma coisa:
// a aba "Cupons do ML" (onde o botão falta) e a "Config Test" (onde é um diagnóstico).
export default function ExtensaoAusente({ compacto = false }) {
  const origem = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
      {!compacto && (
        <>
          O “raspar” abre o navegador no servidor, e o Mercado Livre barra ele com CAPTCHA. Para colher a
          vitrine numa aba <b>deste</b> Chrome,{" "}
        </>
      )}
      {compacto ? "Para instalar: " : ""}instale a extensão da pasta <code>extension/</code> do
      projeto (chrome://extensions › modo do desenvolvedor › “Carregar sem compactação”) e recarregue
      esta página. Se já instalou e ela não respondeu, o endereço desta página —{" "}
      <code>{origem}</code> — precisa estar em{" "}
      <code>content_scripts.matches</code> do <code>extension/manifest.json</code>; depois de mexer,
      recarregue a extensão (↻) e esta página.
    </div>
  );
}
