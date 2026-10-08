// A variável {link_convite} da descrição do grupo (task 11). No popup "Editar
// descrição" o usuário escreve a variável, e cada grupo grava com o PRÓPRIO link
// de convite no lugar dela — no "aplicar em todos", o #2 divulga o #2. Na volta,
// o link do próprio grupo vira a variável de novo, para o texto continuar valendo
// para todos. A duplicação automática passa pelos dois caminhos: o link do grupo
// cheio vira o do grupo novo.
const INVITE_TOKEN = "{link_convite}";

// O link só conta inteiro: o código seguinte não pode continuar com letra/número.
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Troca a variável pelo link deste grupo. Sem a variável, não chama o WhatsApp.
// Sem conseguir o link (número caído, não é admin), o erro sobe para quem chamou.
async function preencherConvite(wa, userId, numberId, jid, texto) {
  if (!texto || !texto.includes(INVITE_TOKEN)) return texto;
  const link = await wa.getInviteLink(userId, numberId, jid);
  return texto.split(INVITE_TOKEN).join(link);
}

// O caminho de volta: o link DESTE grupo vira a variável. Link de outro grupo
// fica como está. Sem conseguir o link, o texto volta cru — é só conveniência.
async function marcarConvite(wa, userId, numberId, jid, texto) {
  if (!texto || !texto.includes("chat.whatsapp.com/")) return texto;
  let link;
  try {
    link = await wa.getInviteLink(userId, numberId, jid);
  } catch {
    return texto;
  }
  if (!link) return texto;
  return texto.replace(new RegExp(`${escapar(link)}(?![A-Za-z0-9])`, "g"), INVITE_TOKEN);
}

module.exports = { INVITE_TOKEN, preencherConvite, marcarConvite };
