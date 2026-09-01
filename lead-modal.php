<!-- ============== MODAL DE ASSINATURA (email + CPF) ============== -->
<!--
Modal identico ao usado no index.html: pede e-mail e CPF antes do
Stripe, porque e a unica chance de barrar quem ja assina ou ja usou
o teste de R$ 1,00 -- o Checkout so coletaria o e-mail depois de
cobrar, e ai a saida seria estorno.

Os botoes que abrem este modal continuam usando o atributo
data-lead-plan (comecar, bronze, prata, ouro). O mapeamento para o
planId/trial que a API de checkout espera esta em MAPA_PLANOS_LEAD,
logo abaixo.
-->
<div x-data="assinar()" x-cloak @keydown.escape.window="fechar()" @abrir-assinatura.window="abrir($event.detail.plano, $event.detail.trial)">
  <div x-show="open" x-transition.opacity class="fixed inset-0 z-[80] flex items-center justify-center p-4" style="background:rgba(10,10,10,0.6); backdrop-filter:blur(4px)" @click.self="fechar()" role="dialog" aria-modal="true" aria-labelledby="assinar-titulo">
    <div class="w-full max-w-md rounded-2xl bg-white p-7 shadow-2xl relative" x-transition>
      <button type="button" @click="fechar()" aria-label="Fechar" class="absolute right-4 top-4 text-stone-400 hover:text-stone-900 transition-colors">
        <i data-lucide="x"></i>
      </button>

      <h3 id="assinar-titulo" class="font-display text-2xl font-bold" style="color:var(--color-ink)">
        <span x-text="trial ? 'Teste 7 dias por R$ 1,00' : 'Assinar ' + nomePlano()"></span>
      </h3>
      <p class="mt-1 text-sm text-stone-500" x-text="resumo()"></p>

      <!--
      Bloqueio nunca termina em beco sem saida: quem ja assina recebe, junto
      da explicacao, o caminho para os planos MAIORES que o dele. O backend
      manda a lista pronta (upgrades / targetPlan), entao a regra de qual
      plano e maior mora num lugar so.
      -->
      <template x-if="bloqueio">
        <div class="mt-5">
          <div class="rounded-xl border border-stone-200 bg-stone-50 p-4 text-sm leading-relaxed text-stone-700" x-text="bloqueio.message"></div>

          <!-- Tentou um plano maior do que o que ja assina: o caminho direto. -->
          <template x-if="bloqueio.targetPlan">
            <div class="mt-4">
              <a :href="bloqueio.targetPlan.url" class="btn-primary flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 font-semibold">
                <span x-text="'Quero assinar o ' + bloqueio.targetPlan.label + ' mesmo assim'"></span>
              </a>
              <p class="mt-2 text-center text-xs text-stone-500">
                Você entra na sua conta e confirma a troca — paga só a diferença, sem começar uma assinatura nova.
              </p>
            </div>
          </template>

          <!-- Demais planos maiores que o atual. -->
          <template x-if="outrosUpgrades().length">
            <div class="mt-4">
              <!-- Com um alvo escolhido, os demais podem ser MAIORES ou MENORES
                   que ele (todos sao maiores que o plano atual, que e o que
                   importa) — dai o rotulo neutro. -->
              <p class="text-xs font-medium uppercase tracking-wide text-stone-500" x-text="bloqueio.targetPlan ? 'Ou escolha outro plano' : 'Planos maiores que o seu'"></p>
              <div class="mt-2 space-y-2">
                <template x-for="p in outrosUpgrades()" :key="p.id">
                  <a :href="p.url" class="flex w-full items-center justify-between rounded-2xl border-2 border-stone-900 bg-white px-5 py-3 font-semibold text-stone-900 transition-colors hover:bg-stone-900 hover:text-white">
                    <span x-text="p.label"></span>
                    <span class="text-sm font-normal" x-text="precoMes(p.priceBRL)"></span>
                  </a>
                </template>
              </div>
            </div>
          </template>

          <!-- Sem upgrade a oferecer (ja esta no maior plano, ou o CPF e de
               outra conta): so a informacao e a entrada do sistema. -->
          <template x-if="!bloqueio.targetPlan && !outrosUpgrades().length">
            <a :href="bloqueio.loginUrl || sistema" class="btn-primary mt-4 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 font-semibold">
              Entrar no sistema
            </a>
          </template>

          <button type="button" @click="bloqueio = null" class="mt-3 w-full text-center text-sm text-stone-500 hover:text-stone-900 transition-colors">
            Tentar com outros dados
          </button>
        </div>
      </template>

      <form x-show="!bloqueio" @submit.prevent="enviar()" class="mt-5 space-y-4">
        <label class="block">
          <span class="text-sm font-medium text-stone-700">Seu e-mail</span>
          <input x-model="email" x-ref="campoEmail" type="email" required maxlength="254" autocomplete="email" placeholder="voce@email.com" class="mt-1.5 w-full rounded-xl border border-stone-300 px-4 py-3 text-base outline-none focus:border-stone-900">
          <span class="mt-1 block text-xs text-stone-500">É com este e-mail que sua conta será criada depois do pagamento.</span>
        </label>
        <label class="block">
          <span class="text-sm font-medium text-stone-700">Seu CPF</span>
          <input x-model="cpf" @input="cpf = mascara(cpf)" inputmode="numeric" required maxlength="14" placeholder="000.000.000-00" class="mt-1.5 w-full rounded-xl border border-stone-300 px-4 py-3 text-base outline-none focus:border-stone-900">
          <span class="mt-1 block text-xs text-stone-500">Cada CPF pode ter uma conta na Nimbus.</span>
        </label>

        <template x-if="erro">
          <p class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700" x-text="erro"></p>
        </template>

        <button type="submit" :disabled="carregando" class="btn-primary flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-base font-semibold disabled:opacity-70">
          <span x-text="carregando ? 'Abrindo pagamento…' : 'Ir para o pagamento'"></span>
        </button>
        <p class="text-center text-xs text-stone-500">
          Pagamento processado pelo Stripe. Não guardamos seu cartão. Sem fidelidade.
        </p>
      </form>

      <!--
      Selo de versao DESTE arquivo, dentro do popup. Existe porque alguns
      cenarios de bloqueio sao visualmente iguais aos da versao antiga: sem o
      selo nao da pra saber se o lead-modal.php novo subiu mesmo. Suba o numero
      junto com o do rodape do index.php a cada troca.
      -->
      <p class="mt-4 text-center text-[10px] text-stone-400" x-text="'modal ' + versao"></p>
    </div>
  </div>
</div>

<script>
// Versao da landing publicada. Serve para confirmar, no site no ar, se a troca
// dos arquivos deu certo: abra o console do navegador (F12) e veja a linha
// "[Nimbus LP]", ou digite NIMBUS_LP_VERSION. O mesmo valor aparece no rodape
// da pagina (index.php). Ao mexer na landing, suba a data nos DOIS arquivos.
window.NIMBUS_LP_VERSION = 'v2026-07-31.2';
console.info('[Nimbus LP] versao', window.NIMBUS_LP_VERSION, '— popup com opcoes de plano maior');

// Endereco do sistema. Trocar aqui e o suficiente para apontar a
// landing para outro ambiente (o backend precisa ter esta origem no CORS).
const NIMBUS_SISTEMA = window.NIMBUS_SISTEMA || 'https://sistema.nimbuspromocoes.com';

// Mapa entre o data-lead-plan usado nos botoes desta pagina e o
// planId/trial que a API de checkout espera (mesmos planId do index.html:
// basic, pro, business).
const MAPA_PLANOS_LEAD = {
  comecar: { plano: 'basic', trial: true },
  bronze:  { plano: 'basic', trial: false },
  prata:   { plano: 'pro', trial: false },
  ouro:    { plano: 'business', trial: false },
};

function assinar() {
  return {
    open: false,
    plano: 'basic',
    trial: false,
    email: '',
    cpf: '',
    carregando: false,
    erro: null,
    bloqueio: null,
    sistema: NIMBUS_SISTEMA,
    versao: window.NIMBUS_LP_VERSION,
    precos: { basic: 'R$ 69,90', pro: 'R$ 99,90', business: 'R$ 149,90' },
    nomes: { basic: 'Bronze', pro: 'Prata', business: 'Ouro' },
    abrir(plano, trial) {
      this.plano = plano;
      this.trial = !!trial;
      this.erro = null;
      this.bloqueio = null;
      this.open = true;
      document.body.style.overflow = 'hidden';
      this.$nextTick(() => {
        if (window.lucide) lucide.createIcons();
        this.$refs.campoEmail?.focus();
      });
    },
    fechar() {
      this.open = false;
      this.carregando = false;
      document.body.style.overflow = '';
    },
    nomePlano() { return this.nomes[this.plano] || ''; },
    // Planos maiores que o atual, tirando o que ja virou botao principal
    // (targetPlan). Vem prontos do backend, com nome e preco do Stripe.
    outrosUpgrades() {
      const alvo = this.bloqueio?.targetPlan?.id;
      return (this.bloqueio?.upgrades || []).filter(p => p.id !== alvo);
    },
    precoMes(v) {
      if (v == null) return '';
      return 'R$ ' + Number(v).toFixed(2).replace('.', ',') + '/mês';
    },
    resumo() {
      const preco = this.precos[this.plano];
      return this.trial
        ? `Plano ${this.nomePlano()} — R$ 1,00 hoje e ${preco} por mês depois dos 7 dias. Cancele quando quiser.`
        : `Plano ${this.nomePlano()} — ${preco} por mês. Cancele quando quiser.`;
    },
    // Mascara progressiva do CPF, sem atrapalhar quem esta digitando.
    mascara(v) {
      const d = String(v || '').replace(/\D/g, '').slice(0, 11);
      if (d.length <= 3) return d;
      if (d.length <= 6) return d.slice(0,3) + '.' + d.slice(3);
      if (d.length <= 9) return d.slice(0,3) + '.' + d.slice(3,6) + '.' + d.slice(6);
      return d.slice(0,3) + '.' + d.slice(3,6) + '.' + d.slice(6,9) + '-' + d.slice(9);
    },
    // Mesmos digitos verificadores conferidos no backend (utils/cpf.js).
    cpfValido(v) {
      const cpf = String(v || '').replace(/\D/g, '');
      if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
      for (const [len, pos] of [[9,10],[10,11]]) {
        let soma = 0;
        for (let i = 0; i < len; i++) soma += Number(cpf[i]) * (pos - i);
        const resto = (soma * 10) % 11;
        if ((resto === 10 ? 0 : resto) !== Number(cpf[len])) return false;
      }
      return true;
    },
    async enviar() {
      this.erro = null;
      const email = this.email.trim().toLowerCase();
      const cpf = this.cpf.replace(/\D/g, '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { this.erro = 'Informe um e-mail válido'; return; }
      if (!this.cpfValido(cpf)) { this.erro = 'Informe um CPF válido'; return; }
      this.carregando = true;
      try {
        const r = await fetch(NIMBUS_SISTEMA + '/api/public/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: this.plano, email, cpf, trial: this.trial }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.url) {
          if (window.fbq) fbq('track', 'InitiateCheckout', { content_name: this.plano });
          window.location.assign(data.url);
          return;
        }
        // 409 = ja assina (ou o CPF e de outra conta). O corpo traz a mensagem
        // e as opcoes de plano maior que a tela renderiza.
        if (r.status === 409) {
          this.bloqueio = {
            message: data.error || 'Este e-mail ou CPF já tem conta na Nimbus.',
            code: data.code || null,
            currentPlanLabel: data.currentPlanLabel || null,
            upgrades: data.upgrades || [],
            targetPlan: data.targetPlan || null,
            loginUrl: data.loginUrl || NIMBUS_SISTEMA,
          };
          this.$nextTick(() => { if (window.lucide) lucide.createIcons(); });
        } else {
          this.erro = data.error || 'Não foi possível abrir o pagamento. Tente de novo.';
        }
      } catch (e) {
        window.location.assign(NIMBUS_SISTEMA + '/assinar?plano=' + this.plano + (this.trial ? '&teste=1' : ''));
        return;
      }
      this.carregando = false;
    },
  };
}

// Os botoes de "Assinar"/"Comecar" desta pagina usam data-lead-plan
// (bronze, prata, ouro, comecar). Este listener traduz o clique no
// evento que o modal Alpine acima escuta (@abrir-assinatura.window).
document.addEventListener('click', function (e) {
  const el = e.target.closest('[data-lead-plan]');
  if (!el) return;
  const cfg = MAPA_PLANOS_LEAD[el.getAttribute('data-lead-plan')];
  if (!cfg) return;
  e.preventDefault();
  e.stopPropagation();
  window.dispatchEvent(new CustomEvent('abrir-assinatura', { detail: { plano: cfg.plano, trial: cfg.trial } }));
}, true);

document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();
});
</script>
