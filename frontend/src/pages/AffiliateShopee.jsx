import { PRIMARY_DARK } from "../data/constants";

export default function PageAffiliateShopee() {
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 500, marginBottom: 6 }}>Shopee</h2>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        Configure o programa de afiliados para gerar links curtos com sua TAG nos envios.
      </div>

      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "32px 20px", textAlign: "center" }}>
        <div style={{ fontSize: 28, marginBottom: 10 }}>🚧</div>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Em breve</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6, maxWidth: 460, margin: "0 auto" }}>
          A integração com afiliados Shopee ainda está em desenvolvimento. Quando estiver disponível, você vai
          poder configurar TAG, cookie e testar URLs por aqui — mesmo formato das outras lojas.
        </div>
        <div style={{ marginTop: 18, fontSize: 11, color: PRIMARY_DARK }}>
          Sem ETA por enquanto. Por enquanto, links da Shopee saem como links crus.
        </div>
      </div>
    </div>
  );
}
