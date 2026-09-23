// Confere se um dump .sql.gz está inteiro antes de confiar nele.
//
// Um pg_dump que morre no meio deixa um gzip truncado (ou um gzip válido só com
// o começo do SQL). Sem esta checagem, esse arquivo subia pro B2 como backup bom
// e um restore dele dropava o banco e recriava só metade. O pg_dump sempre
// termina com "-- PostgreSQL database dump complete" (seguido do \unrestrict nas
// versões novas), então o critério é: gunzip sem erro + esse marcador no fim.

const fs = require("fs");
const zlib = require("zlib");

const FOOTER = "PostgreSQL database dump complete";
const TAIL_BYTES = 4096;

function verifyDumpFile(filePath) {
  return new Promise((resolve, reject) => {
    let tail = Buffer.alloc(0);
    let bytes = 0;
    const fail = (why) => reject(new Error(`dump truncado/corrompido (${why}): ${filePath}`));

    const gunzip = zlib.createGunzip();
    gunzip.on("data", (chunk) => {
      bytes += chunk.length;
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
    });
    gunzip.on("error", (err) => fail(err.message));
    gunzip.on("end", () => {
      if (!tail.toString("utf8").includes(FOOTER)) return fail("sem o marcador de fim do pg_dump");
      resolve({ bytes });
    });

    const rs = fs.createReadStream(filePath);
    rs.on("error", (err) => fail(err.message));
    rs.pipe(gunzip);
  });
}

module.exports = { verifyDumpFile, FOOTER };
