// A porta do módulo: as tabelas (`pg.js`) e a conta do desconto (`price.js`).
// `price.js` fica separado porque é puro — quem só quer calcular preço com cupom
// não precisa arrastar o Prisma junto.
module.exports = { ...require("./pg"), ...require("./price") };
