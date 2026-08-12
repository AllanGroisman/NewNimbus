import { PRIMARY, PRIMARY_DARK, formatPrice, formatCompact, soldText, storeBadgeColor } from "../../data/constants";
import Badge from "./Badge";

// Desconto a partir do qual a faixa fica em verde forte, e a partir do qual
// ganha o 🔥. Só valem com `emphasizeDiscount`.
const BIG_DISCOUNT = 40;
const HUGE_DISCOUNT = 60;

const discountPct = (product) => {
  const n = typeof product.discount === "number"
    ? product.discount
    : parseInt(String(product.discount ?? "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Quanto sai do bolso a menos. Só com os dois preços em número — as lojas às
// vezes trazem o preço já formatado em string.
const savings = (product) => {
  const { price, originalPrice } = product;
  if (typeof price !== "number" || typeof originalPrice !== "number") return null;
  const diff = originalPrice - price;
  return diff > 0 ? diff : null;
};

function reviewsText(product) {
  if (product.reviewsCount == null) return null;
  const raw = String(product.reviewsCount).replace(/[^\d]/g, "");
  if (!raw) return null;
  return formatCompact(Number(raw));
}

// Card compacto para filas/pendentes (horizontal)
export function ProductRow({ product, actions, index }) {
  const hasLink = !!product.link;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      background: "var(--color-background-primary)",
      border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12,
      padding: "10px 14px",
    }}>
      {index != null && (
        <div style={{
          width: 22, height: 22, borderRadius: "50%",
          background: "var(--color-background-secondary)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 10, fontWeight: 500, color: "var(--color-text-secondary)", flexShrink: 0,
        }}>{index}</div>
      )}
      {product.img ? (
        hasLink ? (
          <a href={product.link} target="_blank" rel="noopener noreferrer" style={{
            width: 48, height: 48, borderRadius: 8, overflow: "hidden",
            background: "#fff", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <img src={product.img} alt="" style={{ maxWidth: 48, maxHeight: 48, objectFit: "contain" }} />
          </a>
        ) : (
          <div style={{
            width: 48, height: 48, borderRadius: 8, overflow: "hidden",
            background: "#fff", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <img src={product.img} alt="" style={{ maxWidth: 48, maxHeight: 48, objectFit: "contain" }} />
          </div>
        )
      ) : (
        <div style={{
          width: 48, height: 48, borderRadius: 8, background: "var(--color-background-secondary)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 20, flexShrink: 0,
        }}>📦</div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, fontWeight: 500, lineHeight: 1.3,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}>
          {hasLink
            ? <a href={product.link} target="_blank" rel="noopener noreferrer" style={{ color: PRIMARY_DARK, textDecoration: "underline" }}>{product.name}</a>
            : product.name}
        </div>
        <div style={{ display: "flex", gap: 5, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
          {product.store && <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>{product.store}</span>}
          {product.rating && <Badge color="amber">★ {product.rating}</Badge>}
          {product.discount && <Badge color="green">-{typeof product.discount === "number" ? `${product.discount}%` : product.discount}</Badge>}
          {product.freeShipping && <Badge color="teal">Frete grátis</Badge>}
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0, marginRight: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: PRIMARY_DARK }}>
          {typeof product.price === "number" ? formatPrice(product.price) : product.price}
        </div>
        {product.originalPrice && (
          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", textDecoration: "line-through" }}>
            {typeof product.originalPrice === "number" ? formatPrice(product.originalPrice) : product.originalPrice}
          </div>
        )}
        {product.sendAt && (
          <div style={{ fontSize: 10, color: "var(--color-text-secondary)", marginTop: 2 }}>Envio: {product.sendAt}</div>
        )}
      </div>
      {actions && <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}

// Card grid para catálogo de produtos.
// `footer` e `badge` (opcionais) ficam FORA do <a> — botões não podem viver
// dentro do link que abre o produto na loja.
//
// `showStore` e `emphasizeDiscount` nascem desligados: quem liga é a aba de
// busca da campanha, onde o usuário compara ofertas de três lojas e escolhe
// pelo desconto. O /produtos continua com o card enxuto de sempre.
export function ProductGridCard({ product, footer, badge, showStore = false, emphasizeDiscount = false }) {
  const pct = discountPct(product);
  // A faixa mora no canto da imagem — sem imagem, o desconto fica no selo de
  // sempre, lá no rodapé do card.
  const ribbon = emphasizeDiscount && pct != null && !!product.img;
  const saved = emphasizeDiscount ? savings(product) : null;

  const card = (
    <a
      href={product.link}
      target="_blank"
      rel="noopener noreferrer"
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <div
        style={{
          background: "var(--color-background-primary)",
          border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12,
          padding: 14, display: "flex", flexDirection: "column", gap: 8,
          height: "100%", transition: "border-color 0.2s", cursor: "pointer",
        }}
        onMouseEnter={e => e.currentTarget.style.borderColor = PRIMARY}
        onMouseLeave={e => e.currentTarget.style.borderColor = "var(--color-border-tertiary)"}
      >
        {product.img && (
          <div style={{
            position: "relative", textAlign: "center", height: 120,
            display: "flex", alignItems: "center", justifyContent: "center",
            overflow: "hidden", borderRadius: 8, background: "#fff",
          }}>
            <img src={product.img} alt="" style={{ maxWidth: "100%", maxHeight: 120, objectFit: "contain" }} />
            {ribbon && (
              <span style={{
                position: "absolute", top: 0, left: 0,
                padding: "3px 8px", borderTopLeftRadius: 8, borderBottomRightRadius: 8,
                background: pct >= BIG_DISCOUNT ? "#2F7A18" : "#5B9E3D",
                color: "#fff", fontSize: 12, fontWeight: 600, letterSpacing: 0.2,
              }}>
                {pct >= HUGE_DISCOUNT ? "🔥 " : ""}-{pct}%
              </span>
            )}
          </div>
        )}
        <div style={{
          fontSize: 12, fontWeight: 500, lineHeight: 1.4,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
        }}>{product.name}</div>
        {showStore && product.store ? (
          // A loja é o que muda a decisão (link, frete, confiança); o vendedor
          // vem depois, em cinza, quando existe.
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>
            <Badge color={storeBadgeColor(product.store)}>{product.store}</Badge>
            {product.seller && (
              <span style={{ fontSize: 11, color: "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {product.seller}
              </span>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{product.seller || product.store}</div>
        )}
        {(() => {
          const reviews = reviewsText(product);
          const sold = soldText(product);
          if (!product.rating && !reviews && !sold) return null;
          return (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 11, color: "var(--color-text-secondary)", alignItems: "center" }}>
              {product.rating && (
                <span>
                  <span style={{ color: "#F5A623" }}>★</span> {product.rating}
                  {reviews && <span style={{ marginLeft: 3 }}>({reviews})</span>}
                </span>
              )}
              {!product.rating && reviews && <span>{reviews} avaliações</span>}
              {sold && <span>· {sold}</span>}
            </div>
          );
        })()}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {product.freeShipping && <Badge color="teal">Frete grátis</Badge>}
        </div>
        <div style={{ marginTop: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 500, color: PRIMARY_DARK }}>
                {typeof product.price === "number" ? formatPrice(product.price) : product.price}
              </div>
              {product.originalPrice && (
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", textDecoration: "line-through" }}>
                  {typeof product.originalPrice === "number" ? formatPrice(product.originalPrice) : product.originalPrice}
                </div>
              )}
              {saved != null && (
                <div style={{ fontSize: 11, fontWeight: 500, color: "#2F7A18", marginTop: 1 }}>
                  Economize {formatPrice(saved)}
                </div>
              )}
            </div>
            {/* Com a faixa na imagem o selo aqui embaixo só repetiria o número. */}
            {!ribbon && product.discount && <Badge color="green">-{typeof product.discount === "number" ? `${product.discount}%` : product.discount}</Badge>}
          </div>
        </div>
      </div>
    </a>
  );

  if (!footer && !badge) return card;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {(badge || footer) && (
        // O selo ("Já enviado", "Novo", ...) fica numa faixa acima do card. Ela
        // é reservada mesmo sem selo: numa grade, só o card com selo teria essa
        // altura a mais e começaria 26px abaixo dos vizinhos.
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, minHeight: 20 }}>
          <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>{badge}</div>
        </div>
      )}
      <div style={{ flex: 1 }}>{card}</div>
      {footer && <div style={{ marginTop: 8 }}>{footer}</div>}
    </div>
  );
}
