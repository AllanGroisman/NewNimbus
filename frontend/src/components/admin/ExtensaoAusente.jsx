// O que dizer quando a extensão não respondeu.
//
// Sem ela os botões "no meu Chrome" simplesmente sumiam, e sumir sem explicação é
// pior do que não existir. Vive fora das páginas porque várias dizem a mesma coisa:
// "Cupons do ML" (onde os botões faltam) e "Config Test" (onde é um diagnóstico).
export default function ExtensaoAusente({ compacto = false }) {
  const origem = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
      {!compacto && (
        <>
          Os caminhos “pelo servidor” abrem o navegador lá, e o Mercado Livre barra ele com CAPTCHA.
          Para puxar cupons, colher vitrine, testar palavra e testar cupom numa aba <b>deste</b>{" "}
          Chrome,{" "}
        </>
      )}
      {compacto ? "Para instalar: " : ""}baixe a extensão em <b>Admin › Extensão</b>, instale
      (chrome://extensions › modo do desenvolvedor › “Carregar sem compactação”) e recarregue
      esta página. Se já instalou e ela não respondeu, o endereço desta página —{" "}
      <code>{origem}</code> — precisa estar em{" "}
      <code>content_scripts.matches</code> do <code>extension/manifest.json</code>; depois de mexer,
      recarregue a extensão (↻) e esta página.
    </div>
  );
}
