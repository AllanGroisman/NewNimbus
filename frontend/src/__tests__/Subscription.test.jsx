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
  billingDetails: vi.fn(),
  billingReactivate: vi.fn(),
}));

import { billingMe, billingCheckout, billingPortal, billingDetails, billingReactivate } from "../data/api.js";

function setBillingMe(data) {
  billingMe.mockResolvedValue(data);
}

function setBillingDetails(data) {
  billingDetails.mockResolvedValue(data);
}

const EMPTY_DETAILS = {
  stripeEnabled: true, hasStripeCustomer: false,
  upcomingInvoice: null, paymentMethod: null, invoices: [],
};

let fakeWin;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: detalhes vazios — testes que precisam sobrescrevem com setBillingDetails.
  billingDetails.mockResolvedValue(EMPTY_DETAILS);
  // Mock de window.location.assign — pra não tentar navegar
  delete window.location;
  window.location = { assign: vi.fn(), href: "" };
  // Mock de window.open — checkout/portal abrem o Stripe em aba nova
  fakeWin = { location: "", close: vi.fn() };
  window.open = vi.fn(() => fakeWin);
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
    // Exato: a página também tem "Campanhas ativas" no bloco de uso.
    expect(screen.getByText(/^Ativa$/)).toBeInTheDocument();
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

    await waitFor(() => expect(billingCheckout).toHaveBeenCalledWith("basic", undefined));
    // Abre em aba nova (aberta em branco no clique, URL setada depois)
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(fakeWin.location).toBe("https://stripe.test/cs_basic"));
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("popup bloqueado (window.open → null) cai pro redirect na mesma aba", async () => {
    setBillingMe({
      planId: "pro", effectivePlan: "pro", status: "trialing",
      daysLeftInTrial: 6, hasStripeCustomer: false, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 3, groups: 15 },
    });
    billingCheckout.mockResolvedValue({ url: "https://stripe.test/cs_basic" });
    window.open = vi.fn(() => null); // bloqueador de popup

    render(<PageSubscription />);
    await waitFor(() => screen.getByText(/Nimbus Pro/));
    fireEvent.click(screen.getAllByRole("button", { name: /Assinar/i })[0]);

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
    // A aba aberta em branco é fechada quando o checkout falha
    expect(fakeWin.close).toHaveBeenCalled();
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
    // Portal também abre em aba nova
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    await waitFor(() => expect(fakeWin.location).toBe("https://billing.stripe.test/p/x"));
    expect(window.location.assign).not.toHaveBeenCalled();
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

describe("Subscription — trial de R$1", () => {
  const eligibleMe = {
    planId: "free", effectivePlan: "free", status: "inactive",
    hasStripeCustomer: false, stripeEnabled: true, isAdmin: false,
    trialEligible: true,
    limits: { numbers: 0, groups: 0 },
  };

  it("trialEligible=true mostra CTA 'Testar por R$ 1,00' no Básico", async () => {
    setBillingMe(eligibleMe);
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/15 DIAS POR R\$1/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Testar por R\$ 1,00/i })).toBeInTheDocument();
  });

  it("CTA de trial chama billingCheckout com { trial: true }", async () => {
    setBillingMe(eligibleMe);
    billingCheckout.mockResolvedValue({ url: "https://stripe.test/cs_trial" });
    render(<PageSubscription />);
    await waitFor(() => screen.getByRole("button", { name: /Testar por R\$ 1,00/i }));
    fireEvent.click(screen.getByRole("button", { name: /Testar por R\$ 1,00/i }));
    await waitFor(() => expect(billingCheckout).toHaveBeenCalledWith("basic", { trial: true }));
  });

  it("trialEligible=false não mostra o CTA de trial", async () => {
    setBillingMe({ ...eligibleMe, trialEligible: false });
    render(<PageSubscription />);
    await waitFor(() => screen.getAllByRole("button", { name: /^Assinar$/i }));
    expect(screen.queryByText(/15 DIAS POR R\$1/)).not.toBeInTheDocument();
  });
});

describe("Subscription — cancelamento agendado + reativar", () => {
  const cancelingMe = {
    planId: "pro", effectivePlan: "pro", status: "active",
    cancelAtPeriodEnd: true, daysUntilPeriodEnd: 12,
    currentPeriodEnd: "2026-08-04T00:00:00.000Z",
    hasStripeCustomer: true, stripeEnabled: true, isAdmin: false,
    limits: { numbers: 3, groups: 5 },
  };

  it("mostra banner 'Sua assinatura termina em X dias' com botão de reativar", async () => {
    setBillingMe(cancelingMe);
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/Sua assinatura termina em/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Reativar assinatura/i })).toBeInTheDocument();
  });

  it("clicar reativar chama billingReactivate e atualiza o status", async () => {
    setBillingMe(cancelingMe);
    billingReactivate.mockResolvedValue({ ...cancelingMe, cancelAtPeriodEnd: false });
    render(<PageSubscription />);
    await waitFor(() => screen.getByRole("button", { name: /Reativar assinatura/i }));
    fireEvent.click(screen.getByRole("button", { name: /Reativar assinatura/i }));
    await waitFor(() => expect(billingReactivate).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/Sua assinatura termina em/i)).not.toBeInTheDocument());
  });
});

describe("Subscription — seu plano em uso + detalhes", () => {
  const activeMe = {
    planId: "basic", effectivePlan: "basic", status: "active",
    currentPeriodEnd: "2026-08-10T00:00:00.000Z",
    hasStripeCustomer: true, stripeEnabled: true, isAdmin: false,
    limits: { numbers: 1, groups: 1, whatsappGroupsPerCampaign: 3, categoriesPerGroup: 2 },
    usage: { groups: 1, numbers: 0, maxWhatsappGroupsPerCampaign: 2, maxCategoriesPerGroup: 1 },
  };

  it("mostra benefícios com uso (1/1 campanhas, 0/1 números)", async () => {
    setBillingMe(activeMe);
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/Benefícios e uso/i)).toBeInTheDocument());
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getByText("0/1")).toBeInTheDocument();
  });

  it("mostra próxima cobrança, cartão e histórico de faturas dos details", async () => {
    setBillingMe(activeMe);
    setBillingDetails({
      stripeEnabled: true, hasStripeCustomer: true,
      upcomingInvoice: { amountBRL: 69.9, currency: "brl", nextPaymentAttempt: "2026-08-10T00:00:00.000Z" },
      paymentMethod: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2027 },
      invoices: [{ id: "in_1", date: "2026-07-10T00:00:00.000Z", amountBRL: 69.9, status: "paid", hostedUrl: "https://x/1", pdfUrl: "https://x/1.pdf" }],
    });
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getAllByText(/R\$ 69,90/).length).toBeGreaterThan(0));
    expect(screen.getByText(/Visa •••• 4242/)).toBeInTheDocument();
    expect(screen.getByText(/Histórico de faturas/i)).toBeInTheDocument();
    expect(screen.getByText("Paga")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir/i })).toHaveAttribute("href", "https://x/1");
  });

  it("não mostra 'Scraping' em lugar nenhum e usa 'Categorias de produtos'", async () => {
    setBillingMe(activeMe);
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/Benefícios e uso/i)).toBeInTheDocument());
    expect(screen.queryByText(/Scraping/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Categorias de produtos por campanha/i)).toBeInTheDocument();
  });

  it("card do plano atual fica esmaecido na lista de planos", async () => {
    setBillingMe(activeMe);
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText("SEU PLANO")).toBeInTheDocument());
    // O selo "SEU PLANO" é filho direto do card — o container deve estar esmaecido.
    expect(screen.getByText("SEU PLANO").parentElement).toHaveStyle({ opacity: "0.55" });
  });

  it("sem faturas mostra 'Nenhuma fatura ainda'", async () => {
    setBillingMe(activeMe);
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/Nenhuma fatura ainda/i)).toBeInTheDocument());
  });

  it("effectivePlan=free não mostra seção de uso", async () => {
    setBillingMe({
      planId: "free", effectivePlan: "free", status: "inactive",
      hasStripeCustomer: false, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 0, groups: 0 },
    });
    render(<PageSubscription />);
    await waitFor(() => screen.getByText(/Nimbus Free/));
    expect(screen.queryByText(/Benefícios e uso/i)).not.toBeInTheDocument();
  });
});

describe("Subscription — preços vindos do backend", () => {
  it("usa priceBRL de me.plans quando presente", async () => {
    setBillingMe({
      planId: "free", effectivePlan: "free", status: "inactive",
      hasStripeCustomer: false, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 0, groups: 0 },
      plans: [
        { id: "basic", label: "Básico", priceBRL: 79.9, limits: {} },
        { id: "pro", label: "Pro", priceBRL: 99.9, limits: {} },
        { id: "business", label: "Business", priceBRL: 149.9, limits: {} },
      ],
    });
    render(<PageSubscription />);
    // 79,90 vem do backend (PLAN_META hardcoda 69,90)
    await waitFor(() => expect(screen.getAllByText(/R\$ 79,90/).length).toBeGreaterThan(0));
  });

  it("usa o label de me.plans (nome do produto no Stripe) nos cards e no plano atual", async () => {
    setBillingMe({
      planId: "pro", effectivePlan: "pro", status: "active",
      hasStripeCustomer: true, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 3, groups: 5 },
      plans: [
        { id: "basic", label: "Nimbus Essencial", priceBRL: 69.9, limits: {} },
        { id: "pro", label: "Nimbus Avançado", priceBRL: 99.9, limits: {} },
        { id: "business", label: "Nimbus Empresa", priceBRL: 149.9, limits: {} },
      ],
    });
    render(<PageSubscription />);
    // Renomear o produto no Stripe reflete no site sem deploy.
    await waitFor(() => expect(screen.getByText("Nimbus Essencial")).toBeInTheDocument());
    expect(screen.getByText(/Nimbus Nimbus Avançado/)).toBeInTheDocument();
  });

  it("sem plans no backend cai nos nomes locais", async () => {
    setBillingMe({
      planId: "free", effectivePlan: "free", status: "inactive",
      hasStripeCustomer: false, stripeEnabled: true, isAdmin: false,
      limits: { numbers: 0, groups: 0 },
    });
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText("Básico")).toBeInTheDocument());
  });
});

describe("Subscription — billingMe falha", () => {
  it("mostra erro quando billingMe lança", async () => {
    billingMe.mockRejectedValue(new Error("network down"));
    render(<PageSubscription />);
    await waitFor(() => expect(screen.getByText(/network down/i)).toBeInTheDocument(), { timeout: 3000 });
  });
});
