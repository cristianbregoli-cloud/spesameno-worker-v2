import puppeteer from "@cloudflare/puppeteer";

const ROOT_HOSTS = [
  "italmark.it", "penny.it", "aldi.it", "mdspa.it", "esselunga.it", "carrefour.it",
  "conad.it", "unes.it", "lidl.it", "iperal.it", "latuaspesa.com", "migross.it",
  "coopalleanza3-0.it", "eurospin.it", "rossettogroup.it", "famila.it", "ilgigante.net",
  "supersigma.com", "d-piu.com", "bennet.com", "metro.it"
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const json = (value, status = 200) => Response.json(value, {
  status,
  headers: { ...cors, "Cache-Control": "public, max-age=120, s-maxage=600" }
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const allowedHost = host => ROOT_HOSTS.some(root => host === root || host.endsWith(`.${root}`));

const ADAPTERS = {
  "aldi.it": { url: "https://www.aldi.it/speciali-della-settimana", wait: 6000 },
  "mdspa.it": { url: "https://volantino.mdspa.it/m_nord.html", direct: true },
  "esselunga.it": { url: "https://www.esselunga.it/it-it/promozioni/volantini.html", wait: 5000 },
  "carrefour.it": { url: "https://www.carrefour.it/volantino", wait: 5000 },
  "conad.it": { url: "https://www.conad.it/offerte-e-promozioni", wait: 5000 },
  "unes.it": { url: "https://www.unes.it/it/seleziona-volantino", wait: 5000 },
  "penny.it": { url: "https://www.penny.it/offerte", wait: 4000 }
};

function adapterFor(host) {
  return Object.entries(ADAPTERS).find(([root]) => host === root || host.endsWith(`.${root}`))?.[1];
}

function decodeHtml(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, match => match.includes("__NUXT_DATA__") ? match : " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&euro;|&#8364;/gi, "€")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/\\u20ac/gi, "€")
    .replace(/\\u002F/gi, "/")
    .replace(/\\n|\\r|\\t/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function directExtract(html, query) {
  const clean = decodeHtml(html);
  const wanted = query.trim().toLowerCase();
  const stems = wanted.split(/\s+/).filter(x => x.length > 2).map(x => x.length > 5 ? x.slice(0, -1) : x);
  if (!stems.length) return { result: "", matches: 0, offers: [] };
  const lower = clean.toLowerCase();
  const chunks = [];
  let cursor = 0;
  while (cursor < lower.length && chunks.length < 80) {
    const index = lower.indexOf(stems[0], cursor);
    if (index < 0) break;
    const chunk = clean.slice(Math.max(0, index - 250), Math.min(clean.length, index + 650));
    const normalized = chunk.replace(/\n+/g, "\n").trim();
    if (stems.every(stem => normalized.toLowerCase().includes(stem)) && /€|\b\d+[,.]\d{2}\b/.test(normalized)) chunks.push(normalized);
    cursor = index + stems[0].length;
  }
  const unique = [...new Set(chunks)].slice(0, 30);
  const offers = unique.map(text => {
    const weight = text.match(/\b\d+(?:[,.]\d+)?\s*(?:kg|g|ml|cl|l)\b/i)?.[0] || "";
    const prices = [...text.matchAll(/\b(\d+[,.]\d{2})\s*€/g)].map(match => match[1]);
    const promoPrice = prices.at(-1) || "";
    const nameLines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
    const name = nameLines.find(line => stems.every(stem => line.toLowerCase().includes(stem))) || query;
    return { text: [name, weight, promoPrice && `${promoPrice} €`, "Offerta volantino"].filter(Boolean).join(" · "), image: "", link: "" };
  }).filter((offer, index, array) => array.findIndex(item => item.text === offer.text) === index);
  return { result: offers.map(offer => offer.text).join("\n---\n"), matches: offers.length, offers };
}

async function launchBrowser(binding) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await puppeteer.launch(binding); }
    catch (error) {
      lastError = error;
      if (!String(error).includes("429") || attempt === 3) throw error;
      await sleep(2500 * (attempt + 1));
    }
  }
  throw lastError;
}

async function clickConsent(page) {
  await page.evaluate(() => {
    const words = ["accetta tutti", "accetta", "accetto", "consenti", "continua", "rifiuta"];
    const controls = [...document.querySelectorAll("button,[role=button],a,input[type=button]")];
    const target = controls.find(el => words.some(word => (el.textContent || el.value || "").trim().toLowerCase().startsWith(word)));
    target?.click();
  }).catch(() => undefined);
  await sleep(800);
}

async function applyPostcode(page, cap) {
  if (!/^\d{5}$/.test(cap)) return false;
  const applied = await page.evaluate(postcode => {
    const hints = /cap|codice postale|localit|comune|indirizzo|negozio|punto vendita|store|postal|zip/;
    const inputs = [...document.querySelectorAll("input:not([type=hidden])")];
    const input = inputs.find(el => hints.test(`${el.placeholder} ${el.name} ${el.id} ${el.getAttribute("aria-label")}`.toLowerCase()));
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, postcode);
    input.focus();
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: postcode }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const scope = input.closest("form,section,dialog") || document;
    const button = [...scope.querySelectorAll("button,[role=button],input[type=submit]")]
      .find(el => /cerca|trova|conferma|applica|seleziona|continua|vai|usa/.test((el.textContent || el.value || "").toLowerCase()));
    button?.click();
    return true;
  }, cap).catch(() => false);
  if (applied) await sleep(5000);
  return applied;
}

async function revealOffers(page) {
  for (let pass = 0; pass < 4; pass++) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      const more = [...document.querySelectorAll("button,[role=button],a")]
        .find(el => /mostra (altro|altri|più)|carica altro|vedi tutte|scopri le offerte/.test((el.textContent || "").toLowerCase()));
      more?.click();
    }).catch(() => undefined);
    await sleep(900);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
}

async function extractOffers(page, query, payloads) {
  const data = await page.evaluate(needle => {
    const normalize = value => (value || "").replace(/\s+/g, " ").trim();
    const wanted = normalize(needle).toLowerCase();
    const stems = wanted.split(/\s+/).filter(x => x.length > 2).map(x => x.length > 5 ? x.slice(0, -1) : x);
    const hit = text => stems.length && stems.every(stem => text.toLowerCase().includes(stem));
    const cardSelectors = [
      "article", "li[class*=product]", "div[class*=product]", "div[class*=offer]", "div[class*=promo]",
      "div[class*=card]", "a[href*=prodotto]", "a[href*=product]"
    ];
    const cards = [...document.querySelectorAll(cardSelectors.join(","))];
    const results = [];
    for (const card of cards) {
      const text = normalize(card.innerText || card.textContent);
      const hasPrice = /€|\b\d+[,.]\d{2}\b|prezzo\s*(?:speciale|promo|offerta)/i.test(text);
      if (!hit(text) || !hasPrice || text.length < 5 || text.length > 5000) continue;
      const image = card.querySelector("img")?.currentSrc || card.querySelector("img")?.src || "";
      const link = card.closest("a")?.href || card.querySelector("a")?.href || location.href;
      results.push({ text, image, link });
    }
    const body = normalize(document.body?.innerText || "");
    return { cards: results.slice(0, 80), body, title: document.title, url: location.href };
  }, query);

  const wanted = query.trim().toLowerCase();
  const stems = wanted.split(/\s+/).filter(x => x.length > 2).map(x => x.length > 5 ? x.slice(0, -1) : x);
  const allText = [data.body, ...payloads].join("\n");
  const rawLines = allText.replace(/[{}\[\],]/g, "\n").replace(/\\[nrt]/g, "\n").replace(/[\"']/g, "").split(/\n+/).map(x => x.trim()).filter(Boolean);
  const contexts = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (stems.length && stems.every(stem => rawLines[i].toLowerCase().includes(stem))) {
      const context = rawLines.slice(Math.max(0, i - 5), i + 14).join("\n");
      if (/€|\b\d+[,.]\d{2}\b|prezzo\s*(?:speciale|promo|offerta)/i.test(context)) contexts.push(context);
    }
  }
  const cards = data.cards.filter((card, index, array) => array.findIndex(x => x.text === card.text) === index);
  const legacy = [...new Set(contexts)].slice(0, 120).join("\n---\n");
  const result = cards.length ? cards.map(card => `${card.text}\n${card.image}\n${card.link}`).join("\n---\n") : legacy;
  return { result, offers: cards, matches: cards.length || contexts.length, pageTitle: data.title, finalUrl: data.url };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ ok: true, service: "SpesaMeno adapters", version: 7 });
    let browser;
    try {
      const body = await request.json();
      const requested = new URL(body.url);
      if (requested.protocol !== "https:" || !allowedHost(requested.hostname)) return json({ error: "Sito non autorizzato" }, 403);
      const adapter = adapterFor(requested.hostname);
      const target = new URL(adapter?.url || requested.href);
      if (adapter?.direct) {
        const response = await fetch(target.href, { headers: { "User-Agent": "Mozilla/5.0 (compatible; SpesaMeno/1.0)" } });
        if (!response.ok) throw new Error(`Fonte ${response.status}`);
        const html = await response.text();
        const extracted = directExtract(html, String(body.query || ""));
        return json({ success: true, chainAdapter: Object.keys(ADAPTERS).find(root => requested.hostname.endsWith(root)), locationApplied: false, finalUrl: target.href, pageTitle: "", ...extracted });
      }
      browser = await launchBrowser(env.BROWSER);
      const page = await browser.newPage();
      const payloads = [];
      page.on("response", async response => {
        try {
          const type = (response.headers()["content-type"] || "").toLowerCase();
          const url = response.url().toLowerCase();
          if (!/(json|javascript|text\/plain|text\/html)/.test(type) && !/(api|product|promo|offer|volantin|leaflet|flyer|catalog)/.test(url)) return;
          const text = await response.text();
          const used = payloads.reduce((sum, item) => sum + item.length, 0);
          if (text && text.length < 900000 && used + text.length < 4500000) payloads.push(text);
        } catch { /* opaque or streaming response */ }
      });
      await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1");
      await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 1 });
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 35000 });
      await sleep(adapter?.wait || 3500);
      await clickConsent(page);
      const locationApplied = await applyPostcode(page, String(body.cap || ""));
      await revealOffers(page);
      const extracted = await extractOffers(page, String(body.query || ""), payloads);
      await browser.close();
      browser = undefined;
      return json({ success: true, chainAdapter: Object.keys(ADAPTERS).find(root => requested.hostname.endsWith(root)) || "generic", locationApplied, ...extracted });
    } catch (error) {
      if (browser) await browser.close().catch(() => undefined);
      console.error(JSON.stringify({ event: "browser_adapter_error", message: String(error) }));
      return json({ error: "Impossibile leggere le offerte", detail: String(error) }, 500);
    }
  }
};
