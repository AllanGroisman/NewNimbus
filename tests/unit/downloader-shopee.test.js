// Shopee Vídeo no Admin › Downloader.
//
// A Shopee compartilha o mesmo vídeo por vários formatos de link (página web,
// share-video, universal-link com redir escapado). Todos têm de chegar no
// mesmo postId — é ele que abre a página com o mp4 e os produtos.

import "../helpers/env.js";
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const backend = path.resolve(__dirname, "..", "..", "backend");
const shopee = require(path.join(backend, "downloader", "shopeeVideo.js"));

const ID = "cORbzK94CACV1qodAAAAAA==";

describe("findPostId", () => {
  it.each([
    [`https://sv.shopee.com.br/web/@mirellafabri/video/${ID}`],
    [`https://sv.shopee.com.br/universal-link/share-video/${ID}?c=share_web&smtt=0.0.9`],
    [`https://shopee.com.br/share-video/${ID}?c=share_web`],
    [`https://sv.shopee.com.br/share-video/cORbzK94CACV1qodAAAAAA%3D%3D`],
    [`https://shopee.com.br/universal-link?redir=${encodeURIComponent(`https://sv.shopee.com.br/share-video/${ID}`)}`],
  ])("acha o postId em %s", (url) => {
    expect(shopee.findPostId(url)).toBe(ID);
  });

  it("link encurtado não tem postId até seguir o redirect", () => {
    expect(shopee.findPostId("https://shp.ee/abc123")).toBeNull();
  });
});

describe("isVideoUrl", () => {
  it("reconhece Shopee e ignora as outras plataformas", () => {
    expect(shopee.isVideoUrl("https://shp.ee/abc123")).toBe(true);
    expect(shopee.isVideoUrl(`https://sv.shopee.com.br/web/@x/video/${ID}`)).toBe(true);
    expect(shopee.isVideoUrl("https://www.tiktok.com/@x/video/1")).toBe(false);
    expect(shopee.isVideoUrl("https://www.youtube.com/shorts/abc")).toBe(false);
  });
});
