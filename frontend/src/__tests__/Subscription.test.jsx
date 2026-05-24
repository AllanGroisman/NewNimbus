// Testes do componente PageSubscription — render por status (free/trialing/active/...),
// botão "Assinar" dispara checkout, admin bypass mostra banner, stripeEnabled=false
// desabilita botões.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import PageSubscription from "../pages/Subscription.jsx";

// Mock dos módulos de api antes de importar o componente. Vitest hoist `vi.mock`.
vi.mock("../data/api.js", () => ({
  billingMe: vi.fn(),
  billingCheckout: vi.fn(),
  billingPortal: vi.fn(),
}));

import { billingMe, billingCheckout, billingPortal } from "../data/api.js";

function setBillingMe(data) {
  billingMe.mockResolvedValue(data);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Mock de window.location.assign — pra não tentar navegar
  delete window.location;
  window.location = { assign: vi.fn(), href: "" };
});

describe("Subscription — loading state", () => {
  it("mostra 'Carregando assinatura...' antes de billingMe resolver", () => {
    billingMe.mockReturnValue(new Promise(() => {})); // pendente
    render(<PageSubscription />);
    expect(screen.getByText(/Carregando assinatura/i)).toBeInTheDocument();
  });
});

describe("Subscription — render por status", () => {
  it("trialing/pro: mostra 'Plano atual: Nimbus Pro' + dias restantes", async () => {
    setBillingMe({
      planId: "pro", effectivePlan: "pro", status: "trialing",
      daysLeftInTrial: 5, hasStripeCustomer: false, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 3, groups: 15 },
    });
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/Nimbus Pro/)).toBeInTheDocument());
    expect(screen.getByText(/Trial \(5d restantes\)/i)).toBeInTheDocument();
  });

  it("active/business: mostra status 'Ativa'", async () => {
    setBillingMe({
      planId: "business", effectivePlan: "business", status: "active",
      hasStripeCustomer: true, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 99, groups: 99 },
    });
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/Nimbus Business/)).toBeInTheDocument());
    expect(screen.getByText(/Ativa/i)).toBeInTheDocument();
  });

  it("past_due: mostra badge 'Pagamento atrasado'", async () => {
    setBillingMe({
      planId: "pro", effectivePlan: "free", status: "past_due",
      hasStripeCustomer: true, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 0, groups: 0 },
    });
    render(<PageSubscription />);
    // Pode aparecer mais de uma vez (badge + texto explicativo) — basta existir ao menos um
    await waitFor(() => expect(screen.getAllByText(/Pagamento atrasado/i).length).toBeGreaterThan(0));
  });

  it("canceled: mostra 'Cancelada' e plano efetivo free", async () => {
    setBillingMe({
      planId: "free", effectivePlan: "free", status: "canceled",
      hasStripeCustomer: true, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 0, groups: 0 },
    });
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/Cancelada/i)).toBeInTheDocument());
  });
});

describe("Subscription — admin bypass", () => {
  it("isAdmin=true mostra banner de bypass de cobrança", async () => {
    setBillingMe({
      planId: "free", effectivePlan: "business", status: "inactive",
      hasStripeCustomer: false, stripeEnabled: true, isAdmin: true,
      limits: { numbers: 99, groups: 99 },
    });
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/bypass de cobrança|admin/i)).toBeInTheDocument());
  });
});

describe("Subscription — stripeEnabled=false", () => {
  it("mostra aviso 'pagamentos desabilitados' e desabilita botões Assinar", async () => {
    setBillingMe({
      planId: "free", effectivePlan: "free", status: "inactive",
      hasStripeCustomer: false, stripeEnabled: false, isAdmin: false,
      limits: { numbers: 0, groups: 0 },
    });
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/Pagamentos desabilitados/i)).toBeInTheDocument());
    // Botões "Assinar" devem estar desabilitados
    const assinarBtns = screen.getAllByRole("button", { name: /Assinar/i });
    for (const btn of assinarBtns) {
      expect(btn).toBeDisabled();
    }
  });
});

describe("Subscription — checkout flow", () => {
  it("clicar Assinar no plano basic chama billingCheckout('basic') e redireciona", async () => {
    setBillingMe({
      planId: "pro", effectivePlan: "pro", status: "trialing",
      daysLeftInTrial: 6, hasStripeCustomer: false, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 3, groups: 15 },
    });
    billingCheckout.mockResolvedValue({ url: "https://stripe.test/cs_basic" });

    render(<PageSubscription />);
    await waitFor(() => screen.getByText(/Nimbus Pro/));

    const assinarBtns = screen.getAllByRole("button", { name: /Assinar/i });
    // Primeiro botão é o do plano basic
    fireEvent.click(assinarBtns[0]);

    await waitFor(() => expect(billingCheckout).toHaveBeenCalledWith("basic"));
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("https://stripe.test/cs_basic"));
  });

  it("erro no checkout aparece como mensagem", async () => {
    setBillingMe({
      planId: "pro", effectivePlan: "pro", status: "trialing",
      daysLeftInTrial: 6, hasStripeCustomer: false, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 3, groups: 15 },
    });
    billingCheckout.mockRejectedValue(new Error("Stripe falhou"));

    render(<PageSubscription />);
    await waitFor(() => screen.getByText(/Nimbus Pro/));
    fireEvent.click(screen.getAllByRole("button", { name: /Assinar/i })[0]);

    await waitFor(() => expect(screen.getByText(/Stripe falhou/)).toBeInTheDocument());
  });
});

describe("Subscription — portal", () => {
  it("botão 'Gerenciar pagamento' aparece quando hasStripeCustomer=true", async () => {
    setBillingMe({
      planId: "pro", effectivePlan: "pro", status: "active",
      hasStripeCustomer: true, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 3, groups: 15 },
    });
    render(<PageSubscription />);
    await waitFor(() => screen.getByText(/Nimbus Pro/));
    expect(screen.getByRole("button", { name: /Gerenciar pagamento/i })).toBeInTheDocument();
  });

  it("clicar 'Gerenciar pagamento' chama billingPortal e redireciona", async () => {
    setBillingMe({
      planId: "pro", effectivePlan: "pro", status: "active",
      hasStripeCustomer: true, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 3, groups: 15 },
    });
    billingPortal.mockResolvedValue({ url: "https://billing.stripe.test/p/x" });

    render(<PageSubscription />);
    await waitFor(() => screen.getByText(/Nimbus Pro/));
    fireEvent.click(screen.getByRole("button", { name: /Gerenciar pagamento/i }));

    await waitFor(() => expect(billingPortal).toHaveBeenCalled());
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith("https://billing.stripe.test/p/x"));
  });

  it("não mostra 'Gerenciar pagamento' quando hasStripeCustomer=false", async () => {
    setBillingMe({
      planId: "pro", effectivePlan: "pro", status: "trialing",
      daysLeftInTrial: 6, hasStripeCustomer: false, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 3, groups: 15 },
    });
    render(<PageSubscription />);
    await waitFor(() => screen.getByText(/Nimbus Pro/));
    expect(screen.queryByRole("button", { name: /Gerenciar pagamento/i })).not.toBeInTheDocument();
  });
});

describe("Subscription — billingMe falha", () => {
  it("mostra erro quando billingMe lança", async () => {
    billingMe.mockRejectedValue(new Error("network down"));
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/network down/i)).toBeInTheDocument(), { timeout: 3000 });
  });
});
