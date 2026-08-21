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
const ESSELUNGA_STORES_URL = "https://www.esselunga.it/services/istituzionale35/all-stores.json";
// Public browser key published by Esselunga on its store-locator page.
const ESSELUNGA_HERE_KEY = "p-Hih8fjYA1cSsL8gcVmnLj5U871xQ6uSQp4NJ0Ut8A";

const ADAPTERS = {
  "aldi.it": { url: "https://www.aldi.it/speciali-della-settimana", wait: 6000 },
  "mdspa.it": { url: "https://volantino.mdspa.it/m_nord.html", direct: true },
  "esselunga.it": { url: "https://www.esselunga.it/it-it/negozi.html", wait: 5000, storeFlow: "esselunga" },
  "carrefour.it": { url: "https://www.carrefour.it/volantino", wait: 5000 },
  "conad.it": { url: "https://www.conad.it/ricerca-negozi", wait: 5000, storeFlow: "conad" },
  "unes.it": { url: "https://www.unes.it/it/seleziona-volantino", wait: 5000 },
  "penny.it": { url: "https://www.penny.it/offerte", wait: 4000 }
};

function adapterFor(host) {
  return Object.entries(ADAPTERS).find(([root]) => host === root || host.endsWith(`.${root}`))?.[1];
}

function haversineKm(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function resolveEsselunga(cap, radiusKm = 10) {
  if (!/^\d{5}$/.test(cap)) return { locationApplied: false, storeUrl: "", targetUrl: "", nearby: false };
  const geocodeUrl = new URL("https://geocode.search.hereapi.com/v1/geocode");
  geocodeUrl.searchParams.set("q", `${cap} Italia`);
  geocodeUrl.searchParams.set("in", "countryCode:ITA");
  geocodeUrl.searchParams.set("lang", "it");
  geocodeUrl.searchParams.set("apiKey", ESSELUNGA_HERE_KEY);
  const [geocodeResponse, storesResponse] = await Promise.all([
    fetch(geocodeUrl, { headers: { Accept: "application/json" } }),
    fetch(ESSELUNGA_STORES_URL, { headers: { Accept: "application/json" } })
  ]);
  if (!geocodeResponse.ok || !storesResponse.ok) throw new Error("Servizio punti vendita Esselunga non disponibile");
  const [geocode, storePayload] = await Promise.all([geocodeResponse.json(), storesResponse.json()]);
  const position = geocode?.items?.find(item => item?.position)?.position;
  if (!position) return { locationApplied: false, storeUrl: "", targetUrl: "", nearby: false };
  const stores = Array.isArray(storePayload?.stores) ? storePayload.stores : [];
  const ranked = stores
    .filter(store => !store.laEsse && Number.isFinite(Number(store.latitude)) && Number.isFinite(Number(store.longitude)) && store.abbrev)
    .map(store => ({ ...store, distanceKm: haversineKm(position, { lat: Number(store.latitude), lng: Number(store.longitude) }) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const store = ranked[0];
  if (!store || store.distanceKm > radiusKm) {
    return { locationApplied: true, storeUrl: "", targetUrl: "", nearby: false, nearestDistanceKm: store ? Number(store.distanceKm.toFixed(1)) : null };
  }
  const abbrev = encodeURIComponent(String(store.abbrev).toLowerCase());
  const targetUrl = `https://www.esselunga.it/it-it/promozioni/volantini.${abbrev}.html`;
  return {
    locationApplied: true,
    nearby: true,
    storeName: store.description || store.name || "Esselunga",
    storeAddress: [store.address, store.zipCode, store.city, store.province].filter(Boolean).join(", "),
    distanceKm: Number(store.distanceKm.toFixed(1)),
    storeUrl: targetUrl,
    targetUrl
  };
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

async function applyPostcode(page, cap, flow = "") {
  if (!/^\d{5}$/.test(cap)) return false;
  const applied = await page.evaluate(() => {
    const hints = /cap|codice postale|localit|comune|indirizzo|negozio|punto vendita|store|postal|zip/;
    const inputs = [...document.querySelectorAll("input:not([type=hidden])")];
    const input = inputs.find(el => hints.test(`${el.placeholder} ${el.name} ${el.id} ${el.getAttribute("aria-label")}`.toLowerCase()));
    if (!input) return false;
    input.focus();
    input.select();
    return true;
  }).catch(() => false);
  if (applied) {
    // Real keystrokes are required by the React-controlled store finders.
    await page.keyboard.type(cap, { delay: 70 });
    await sleep(1200);
    // Use Puppeteer's mouse click (trusted event), not DOM element.click().
    const controls = await page.$$("button,[role=button],input[type=submit]");
    const candidates = [];
    for (const control of controls) {
      const info = await control.evaluate((el, storeFlow) => {
        const label = (el.textContent || el.value || el.getAttribute("aria-label") || "").trim().toLowerCase();
        const visible = Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const exact = storeFlow === "conad" ? label === "cerca"
          : storeFlow === "esselunga" ? label.includes("avvia ricerca")
          : /^(cerca|trova|avvia ricerca|conferma|applica|seleziona|continua|vai|usa)/.test(label);
        return { visible, exact };
      }, flow).catch(() => ({ visible: false, exact: false }));
      if (info.visible && info.exact) candidates.push(control);
    }
    const target = flow === "conad" ? candidates.at(-1) : candidates[0];
    if (target) await target.click().catch(() => undefined);
    else await page.keyboard.press("Enter").catch(() => undefined);
    await sleep(5500);
  }
  return applied;
}

async function firstMatchingHref(page, rules) {
  return page.evaluate(patterns => {
    const links = [...document.querySelectorAll("a[href]")];
    for (const rule of patterns) {
      const regex = new RegExp(rule.href, "i");
      const textRegex = rule.text ? new RegExp(rule.text, "i") : null;
      const link = links.find(el => regex.test(el.href) && (!textRegex || textRegex.test((el.textContent || "").trim())));
      if (link) return link.href;
    }
    return "";
  }, rules).catch(() => "");
}

async function resolveStoreOffers(page, flow, cap) {
  if (!flow) return { locationApplied: await applyPostcode(page, cap), storeUrl: "" };
  const locationApplied = await applyPostcode(page, cap, flow);
  if (!locationApplied) return { locationApplied: false, storeUrl: "" };
  await sleep(3500);

  const storeRules = flow === "conad"
    ? [{ href: "/ricerca-negozi/.+--[0-9]+" }]
    : [
        { href: "/it-it/negozi/[^?#]+", text: "scopri|dettagli|esselunga" },
        { href: "/it-it/negozi/[^?#]+" }
      ];
  const storeUrl = await firstMatchingHref(page, storeRules);
  if (!storeUrl) return { locationApplied, storeUrl: "" };
  await page.goto(storeUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
  await sleep(3500);
  await clickConsent(page);

  const offerRules = flow === "conad"
    ? [
        { href: "offert|volantin", text: "scopri tutte le offerte|volantin|offert" },
        { href: "offert|volantin" }
      ]
    : [
        { href: "/promozioni/volantini", text: "offert|promozion|volantin" },
        { href: "/promozioni/volantini" }
      ];
  const offerUrl = await firstMatchingHref(page, offerRules);
  if (offerUrl) {
    await page.goto(offerUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
    await sleep(4500);
  }
  return { locationApplied, storeUrl };
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
  // Product grids often wrap the matching card in larger category containers.
  // When a compact product card exists, discard those noisy parent containers.
  const compactCards = cards.filter(card => card.text.length <= 700);
  const selectedCards = compactCards.length ? compactCards : cards;
  const legacy = [...new Set(contexts)].slice(0, 120).join("\n---\n");
  const result = selectedCards.length ? selectedCards.map(card => `${card.text}\n${card.image}\n${card.link}`).join("\n---\n") : legacy;
  return { result, offers: selectedCards, matches: selectedCards.length || contexts.length, pageTitle: data.title, finalUrl: data.url };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ ok: true, service: "SpesaMeno adapters", version: 16 });
    let browser;
    try {
      const body = await request.json();
      const requested = new URL(body.url);
      if (requested.protocol !== "https:" || !allowedHost(requested.hostname)) return json({ error: "Sito non autorizzato" }, 403);
      const adapter = adapterFor(requested.hostname);
      let target = new URL(adapter?.url || requested.href);
      let directLocation = null;
      if (adapter?.storeFlow === "esselunga") {
        const radius = Math.min(100, Math.max(1, Number(body.radius || body.radiusKm || 10)));
        directLocation = await resolveEsselunga(String(body.cap || ""), radius);
        if (!directLocation.targetUrl) {
          return json({
            success: true,
            chainAdapter: "esselunga.it",
            locationApplied: directLocation.locationApplied,
            nearbyStore: false,
            nearestDistanceKm: directLocation.nearestDistanceKm ?? null,
            result: "",
            matches: 0,
            offers: [],
            finalUrl: adapter.url,
            pageTitle: ""
          });
        }
        target = new URL(directLocation.targetUrl);
      }
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
      let payloadBytes = 0;
      page.on("response", async response => {
        try {
          const type = (response.headers()["content-type"] || "").toLowerCase();
          const url = response.url().toLowerCase();
          if (!/(json|text\/plain)/.test(type) && !/(api|product|promo|offer|volantin|leaflet|flyer|catalog)/.test(url)) return;
          if (payloadBytes >= 700000) return;
          const text = await response.text();
          if (text && text.length < 350000 && payloadBytes + text.length < 700000) {
            payloads.push(text);
            payloadBytes += text.length;
          }
        } catch { /* opaque or streaming response */ }
      });
      await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1");
      await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 1 });
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 35000 });
      await sleep(adapter?.wait || 3500);
      await clickConsent(page);
      const location = directLocation || await resolveStoreOffers(page, adapter?.storeFlow, String(body.cap || ""));
      await revealOffers(page);
      const extracted = await extractOffers(page, String(body.query || ""), payloads);
      await browser.close();
      browser = undefined;
      return json({
        success: true,
        chainAdapter: Object.keys(ADAPTERS).find(root => requested.hostname.endsWith(root)) || "generic",
        locationApplied: location.locationApplied,
        nearbyStore: location.nearby ?? undefined,
        storeName: location.storeName || undefined,
        storeAddress: location.storeAddress || undefined,
        distanceKm: location.distanceKm ?? undefined,
        storeUrl: location.storeUrl,
        ...extracted
      });
    } catch (error) {
      if (browser) await browser.close().catch(() => undefined);
      console.error(JSON.stringify({ event: "browser_adapter_error", message: String(error) }));
      return json({ error: "Impossibile leggere le offerte", detail: String(error) }, 500);
    }
  }
};
