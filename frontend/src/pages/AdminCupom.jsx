// Admin › Cupom — os cupons do Mercado Livre: a lista que o ML oferece para a
// conta do sistema, os códigos que a captura pescou nos grupos líderes e o
// dicionário palavra → campanha.
import { useState } from "react";
import { PRIMARY, PRIMARY_DARK } from "../data/constants";
import CuponsDoML from "./AdminCupomML";
import ConfigTest from "./AdminCupomConfig";
import DescobrirPalavra from "./AdminCupomPalavra";
import CuponsDoRepasse from "./AdminCupomRepasse";
import CuponsDoProduto from "./AdminCupomProduto";

// Cinco perguntas diferentes moram nesta página, e cada uma tem a sua aba:
// "Cupons do ML" é a lista que o Mercado Livre oferece para a conta do sistema,
// com os produtos de cada cupom (AdminCupomML.jsx) — é a que abre primeiro;
// "Cupons do produto" são os cupons que cobrem um produto (AdminCupomProduto.jsx);
// "Repasse" são os códigos que a captura pescou nas legendas dos grupos líderes,
// com o teste e a integração de cada um (AdminCupomRepasse.jsx); "Descobrir
// palavra" descobre a que campanha uma palavra pertence (AdminCupomPalavra.jsx);
// "Config Test" confere — e conserta — o que a colheita de vitrines precisa pra
// rodar (AdminCupomConfig.jsx).
export default function PageAdminCupom() {
  const [aba, setAba] = useState("ml");
  // A campanha que a aba "Descobrir palavra" mandou ver na aba "Cupons do ML". O
  // vaivém precisa passar por aqui porque a aba é estado desta página — e sem ele o
  // usuário sai daqui com um número de campanha na mão e tem de colá-lo na busca da
  // outra aba, que é exatamente o trabalho manual que o vínculo palavra↔campanha
  // existe para poupar.
  const [verCupom, setVerCupom] = useState(null);

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Cupom</h1>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          Confere um cupom antes de ele ir pro grupo — e guarda os cupons que o ML oferece.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          ["ml", "Cupons do ML"],
          ["produto", "Cupons do produto"],
          ["repasse", "Repasse"],
          ["palavra", "Descobrir palavra"],
          ["config", "Config Test"],
        ].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setAba(id)}
            style={{
              padding: "7px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer",
              border: `1px solid ${aba === id ? PRIMARY : "var(--color-border-tertiary)"}`,
              background: aba === id ? "var(--color-background-secondary)" : "transparent",
              color: aba === id ? PRIMARY_DARK : "var(--color-text-primary)",
              fontWeight: aba === id ? 600 : 400,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {aba === "produto" && <CuponsDoProduto />}
      {aba === "ml" && <CuponsDoML buscaInicial={verCupom} />}
      {aba === "repasse" && <CuponsDoRepasse />}
      {aba === "palavra" && (
        <DescobrirPalavra onVerCupom={(id) => { setVerCupom(String(id)); setAba("ml"); }} />
      )}
      {aba === "config" && <ConfigTest />}
    </div>
  );
}
