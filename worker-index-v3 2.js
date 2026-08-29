import puppeteer from "@cloudflare/puppeteer";
import { inflateSync } from "node:zlib";

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
// Public store-finder identifier published on Aldi's official Italian website.
const ALDI_STORE_FINDER_KEY = "J8f9erNQcUhg1nmo5Bhp8wy2A6mQkK";

const ADAPTERS = {
  "iperal.it": { url: "https://www.iperal.it/promozioni/", storeFlow: "iperal" },
  "eurospin.it": { url: "https://www.eurospin.it/promozioni/", storeFlow: "eurospin" },
  "lidl.it": { url: "https://www.lidl.it/c/volantino-lidl/s10018048", storeFlow: "lidl" },
  "aldi.it": { url: "https://www.aldi.it/volantino-online", storeFlow: "aldi" },
  "mdspa.it": { url: "https://www.mdspa.it/volantino", storeFlow: "md" },
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

async function geocodeItalianPostcode(cap) {
  if (!/^\d{5}$/.test(cap)) return null;
  const url = new URL("https://geocode.search.hereapi.com/v1/geocode");
  url.searchParams.set("q", `${cap} Italia`);
  url.searchParams.set("in", "countryCode:ITA");
  url.searchParams.set("lang", "it");
  url.searchParams.set("apiKey", ESSELUNGA_HERE_KEY);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Geolocalizzazione CAP ${response.status}`);
  const payload = await response.json();
  return payload?.items?.find(item => item?.position)?.position || null;
}

async function resolveLidl(cap, radiusKm = 10) {
  const position = await geocodeItalianPostcode(cap);
  if (!position) return { locationApplied: false, nearby: false };

  const url = new URL("https://discover.search.hereapi.com/v1/discover");
  url.searchParams.set("at", `${position.lat},${position.lng}`);
  url.searchParams.set("q", "Lidl");
  url.searchParams.set("limit", "12");
  url.searchParams.set("lang", "it");
  url.searchParams.set("apiKey", ESSELUNGA_HERE_KEY);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Ricerca punti vendita Lidl ${response.status}`);
  const payload = await response.json();
  const ranked = (Array.isArray(payload?.items) ? payload.items : [])
    .filter(store => /\blidl\b/i.test(String(store.title || "")) && store.position)
    .map(store => ({ ...store, distanceKm: haversineKm(position, store.position) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const store = ranked[0];
  if (!store || store.distanceKm > radiusKm) {
    return { locationApplied: true, nearby: false,
      nearestDistanceKm: store ? Number(store.distanceKm.toFixed(1)) : null };
  }

  const address = store.address || {};
  return {
    locationApplied: true,
    nearby: true,
    storeId: String(store.id || ""),
    storeName: `Lidl ${address.city || address.district || cap}`,
    storeAddress: String(address.label || "").replace(/^LIDL,\s*/i, ""),
    distanceKm: Number(store.distanceKm.toFixed(1)),
    storeUrl: "https://www.lidl.it/s/it-IT/ricerca-negozio/",
    targetUrl: "https://www.lidl.it/c/volantino-lidl/s10018048",
    regionId: "400"
  };
}

async function resolveEurospin(cap, radiusKm = 10) {
  const position = await geocodeItalianPostcode(cap);
  if (!position) return { locationApplied: false, nearby: false };
  const url = new URL("https://discover.search.hereapi.com/v1/discover");
  url.searchParams.set("at", `${position.lat},${position.lng}`);
  url.searchParams.set("q", "Eurospin");
  url.searchParams.set("limit", "12");
  url.searchParams.set("lang", "it");
  url.searchParams.set("apiKey", ESSELUNGA_HERE_KEY);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Ricerca punti vendita Eurospin ${response.status}`);
  const payload = await response.json();
  const store = (Array.isArray(payload?.items) ? payload.items : [])
    .filter(item => /\beurospin\b/i.test(String(item.title || "")) && item.position)
    .map(item => ({ ...item, distanceKm: haversineKm(position, item.position) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];
  if (!store || store.distanceKm > radiusKm) {
    return { locationApplied: true, nearby: false,
      nearestDistanceKm: store ? Number(store.distanceKm.toFixed(1)) : null };
  }
  const address = store.address || {};
  return {
    locationApplied: true, nearby: true, storeId: String(store.id || ""),
    storeName: `Eurospin ${address.city || address.district || cap}`,
    storeAddress: String(address.label || "").replace(/^EUROSPIN,\s*/i, ""),
    distanceKm: Number(store.distanceKm.toFixed(1)),
    storeUrl: "https://www.eurospin.it/punti-vendita/",
    targetUrl: "https://www.eurospin.it/promozioni/"
  };
}

async function resolveIperal(cap, radiusKm = 10) {
  const position = await geocodeItalianPostcode(cap);
  if (!position) return { locationApplied: false, nearby: false };
  const url = new URL("https://discover.search.hereapi.com/v1/discover");
  url.searchParams.set("at", `${position.lat},${position.lng}`);
  url.searchParams.set("q", "Iperal");
  url.searchParams.set("limit", "16");
  url.searchParams.set("lang", "it");
  url.searchParams.set("apiKey", ESSELUNGA_HERE_KEY);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Ricerca punti vendita Iperal ${response.status}`);
  const payload = await response.json();
  const store = (Array.isArray(payload?.items) ? payload.items : [])
    .filter(item => /\biperal\b/i.test(String(item.title || "")) && item.position)
    .map(item => ({ ...item, distanceKm: haversineKm(position, item.position) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)[0];
  if (!store || store.distanceKm > radiusKm) {
    return { locationApplied: true, nearby: false,
      nearestDistanceKm: store ? Number(store.distanceKm.toFixed(1)) : null };
  }
  const address = store.address || {};
  return {
    locationApplied: true, nearby: true, storeId: String(store.id || ""),
    storeName: `Iperal ${address.city || address.district || cap}`,
    storeAddress: String(address.label || "").replace(/^IPERAL,\s*/i, ""),
    city: String(address.city || address.district || ""),
    county: String(address.county || ""),
    distanceKm: Number(store.distanceKm.toFixed(1)),
    storeUrl: "https://www.iperal.it/punti-vendita/",
    targetUrl: "https://www.iperal.it/promozioni/"
  };
}

function iperalProductCards(html) {
  return [...html.matchAll(/<div\b[^>]*class=["'][^"']*card_footer[^"']*["'][\s\S]*?<\/p>/gi)]
    .map(match => {
      const card = match[0];
      return {
        title: decodeLidlHtml(card.match(/<strong>([\s\S]*?)<\/strong>/i)?.[1]).replace(/\s+/g, " "),
        weight: decodeLidlHtml(card.match(/<span>([\s\S]*?)<\/span>/i)?.[1]).replace(/\s+/g, " "),
        image: decodeLidlHtml(card.match(/<img\b[^>]*\bdata-src=["']([^"']+)/i)?.[1]
          || card.match(/<img\b[^>]*\bsrc=["']([^"']+)/i)?.[1])
      };
    }).filter(card => card.title);
}

function iperalEnrichOffer(offer, cards, viewerUrl, query) {
  if (normalizeProductSearch(query) === "pasta" && /\bpasta\s+(?:gialla|bianca)\b/i.test(offer.name)) return null;
  if (/^(frutta|verdura|verdure|ortaggi|ortofrutta|carne|carni|pollame|pesce|pesci|latticini|formaggi|formaggio|bevande|bibite)$/.test(normalizeProductSearch(query))
      && !eurospinProductMatches(offer.name, "", query)) return null;
  const offerName = normalizeProductSearch(offer.name);
  const terms = offerName.split(/\s+/).filter(term => term.length > 3);
  const card = cards.map(item => {
    const title = normalizeProductSearch(item.title);
    const common = terms.filter(term => title.includes(term)).length;
    return { item, score: common / Math.max(title.split(/\s+/).filter(term => term.length > 3).length, 1), common };
  }).filter(item => item.common && item.score >= 0.5)
    .sort((a, b) => b.common - a.common || b.score - a.score)[0]?.item;
  const information = `${offer.name} ${card?.weight || ""}`;
  const forward = information.match(/(?:^|\s)(kg|g|ml|cl|l|lt)\s*(\d+(?:[.,]\d+)?)(?:\s*[x×]\s*(\d+))?\b/i);
  const reverse = information.match(/(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l|lt)\b/i);
  const measure = String(forward?.[1] || reverse?.[3] || "").toLowerCase();
  const amount = Number(String(forward?.[2] || reverse?.[2] || 0).replace(",", "."));
  const count = Number(forward?.[3] || reverse?.[1] || 1);
  const quantity = amount * count / (measure === "g" || measure === "ml" ? 1000 : measure === "cl" ? 100 : 1);
  const unitMeasure = /^(ml|cl|l|lt)$/.test(measure) ? "L" : measure ? "KG" : undefined;
  const unitPrice = quantity > 0 ? Number((offer.price / quantity).toFixed(2)) : undefined;
  const unitLabel = unitPrice && unitMeasure ? `€/${unitMeasure.toLowerCase()}` : undefined;
  return {
    ...offer, code: offer.code.replace(/^conad-pdf-/, "iperal-pdf-"),
    text: [offer.name, `${formatEuro(offer.price)} €`, unitPrice ? `${formatEuro(unitPrice)} ${unitLabel}` : ""]
      .filter(Boolean).join(" · "),
    image: card?.image || "", link: viewerUrl, unitPrice, unitMeasure, unitLabel
  };
}

async function searchIperalOffers(location, query) {
  const promotionsResponse = await fetch(location.targetUrl, {
    headers: { Accept: "text/html" }, cf: { cacheTtl: 900, cacheEverything: true }
  });
  if (!promotionsResponse.ok) throw new Error(`Promozioni Iperal ${promotionsResponse.status}`);
  const promotions = await promotionsResponse.text();
  const viewers = [...new Set([...promotions.matchAll(/https:\/\/iperal\.volantinopiu\.com\/volantino\d+\.html/g)]
    .map(match => match[0]))];
  if (!viewers.length) throw new Error("Volantino ufficiale Iperal non disponibile");
  const place = normalizeProductSearch(`${location.city} ${location.county} ${location.storeName}`);
  const mountain = /\b(adamello|darfo|breno|esine|sonico|casnigo|clusone|costa volpino|vertova|sondrio|bianzone|carlazzo|dongo|morbegno|rogolo|sondalo|brescia)\b/.test(place);
  const milan = /\b(milano|milano citta)\b/.test(place);
  const preferred = mountain ? "valtellina" : milan ? "milano" : "brianza";
  let selected;
  for (const viewerUrl of viewers.slice(0, 5)) {
    const response = await fetch(viewerUrl, {
      headers: { Accept: "text/html" }, cf: { cacheTtl: 900, cacheEverything: true }
    });
    if (!response.ok) continue;
    const html = await response.text();
    const title = decodeLidlHtml(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
    if (!normalizeProductSearch(title).includes(preferred)) continue;
    const pdfUrl = decodeLidlHtml(html.match(/href=["'](https:\/\/resourcespiu\.volantinopiu\.it\/flyer\/[^"']+\.pdf)["']/i)?.[1]);
    if (!pdfUrl || new URL(pdfUrl).hostname !== "resourcespiu.volantinopiu.it") continue;
    selected = { viewerUrl, title, html, pdfUrl };
    break;
  }
  if (!selected) throw new Error(`Volantino Iperal ${preferred} non disponibile`);
  const cleanQuery = String(query || "").trim().slice(0, 100);
  let extracted = cleanQuery ? await searchConadPdfFlyer(selected.pdfUrl, cleanQuery)
    : { offers: [], pagesChecked: 0, totalPages: 0 };
  const cards = iperalProductCards(selected.html);
  let sharedCampaign = false;
  if (cleanQuery && !extracted.offers.length && preferred !== "valtellina") {
    for (const viewerUrl of viewers.slice(0, 5)) {
      if (viewerUrl === selected.viewerUrl) continue;
      const response = await fetch(viewerUrl, { headers: { Accept: "text/html" },
        cf: { cacheTtl: 900, cacheEverything: true } });
      if (!response.ok) continue;
      const html = await response.text();
      const title = decodeLidlHtml(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
      if (!normalizeProductSearch(title).includes("valtellina")) continue;
      const sameCampaign = normalizeProductSearch(title.split("|").slice(1).join("|"))
        === normalizeProductSearch(selected.title.split("|").slice(1).join("|"));
      const referenceCards = iperalProductCards(html);
      const sameProducts = cards.length > 0 && cards.length === referenceCards.length
        && cards.every((card, index) => normalizeProductSearch(card.title)
          === normalizeProductSearch(referenceCards[index].title));
      if (!sameCampaign || !sameProducts) break;
      const pdfUrl = decodeLidlHtml(html.match(/href=["'](https:\/\/resourcespiu\.volantinopiu\.it\/flyer\/[^"']+\.pdf)["']/i)?.[1]);
      if (!pdfUrl || new URL(pdfUrl).hostname !== "resourcespiu.volantinopiu.it") break;
      extracted = await searchConadPdfFlyer(pdfUrl, cleanQuery);
      sharedCampaign = true;
      break;
    }
  }
  const offers = extracted.offers.map(offer => iperalEnrichOffer(offer, cards, selected.viewerUrl, cleanQuery))
    .filter(offer => !sharedCampaign || Boolean(offer?.image))
    .filter(Boolean).sort((a, b) => a.price - b.price);
  return {
    result: offers.map(offer => `${offer.text}\n${offer.image}\n${offer.link}`).join("\n---\n"),
    matches: offers.length, offers, finalUrl: selected.viewerUrl,
    pageTitle: `Offerte volantino ${location.storeName} · ${selected.title}`,
    flyersChecked: 1, flyerProducts: cards.length, pdfPagesChecked: extracted.pagesChecked,
    flyerEdition: preferred, sourceFormat: sharedCampaign ? "iperal-official-shared-campaign" : "iperal-official-pdf"
  };
}

function eurospinProductMatches(name, brand, query) {
  const wanted = normalizeProductSearch(query).trim();
  const haystack = normalizeProductSearch(`${name} ${brand}`);
  if (!wanted) return false;
  const groups = [
    [/^frutta$/, /\b(?:mel[ae]|per[ae]|pesche|nettari(?:na|ne)|uva|banan[ae]|albicocc[ah]|susin[ae]|prugn[ae]|meloni?|anguri[ae]|fragol[ae]|kiwi|aranc[ei]|frutta fresca)\b/],
    [/^(verdura|verdure|ortaggi|ortofrutta)$/, /\b(?:patat[ae]|pomodor[io]|carot[ae]|zucchin[ae]|peperon[ei]|melanzan[ae]|insalat[ae]|cipoll[ae]|verdure?|ortaggi)\b/],
    [/^(carne|carni|pollame)$/, /\b(?:carne|pollo|tacchino|suino|manzo|salsiccia|hamburger|cotolett[ae])\b/],
    [/^(pesce|pesci)$/, /\b(?:pesce|tonno|salmone|merluzzo|orata|branzino|gamber[io])\b/],
    [/^(latticini|formaggi|formaggio)$/, /\b(?:latte|formaggi[oa]|mozzarella|parmigiano|grana|yogurt|ricotta|burro)\b/],
    [/^(bevande|bibite)$/, /\b(?:acqua|bibit[ae]|succo|succhi|aranciata|cola|birra|vino)\b/]
  ];
  const category = groups.find(([pattern]) => pattern.test(wanted))?.[1];
  if (category) {
    if (wanted === "frutta" && /\b(?:succo|succhi|polpa|confettura|marmellata|yogurt|bevanda|bibita|bibite|biscotti|cani|gatti|salsa|gelato|colform)\b/.test(haystack)) return false;
    return category.test(haystack);
  }
  return wanted.split(/\s+/).filter(word => word.length > 2).every(word => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = word.length > 4 && /[aeio]$/.test(word)
      ? `\\b${escaped.slice(0, -1)}[aeio]?\\b` : `\\b${escaped}\\b`;
    return new RegExp(expression).test(haystack);
  });
}

function eurospinOfferCurrentlyValid(period) {
  const bounds = period.match(/(\d{1,2})\.(\d{1,2})\s*-\s*(\d{1,2})\.(\d{1,2})/);
  if (!bounds) return true;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const year = Number(today.slice(0, 4));
  const startMonth = Number(bounds[2]);
  const endMonth = Number(bounds[4]);
  const todayMonth = Number(today.slice(5, 7));
  const startYear = startMonth === 12 && todayMonth === 1 ? year - 1 : year;
  const endYear = endMonth < startMonth ? startYear + 1 : startYear;
  const start = `${startYear}-${String(startMonth).padStart(2, "0")}-${bounds[1].padStart(2, "0")}`;
  const end = `${endYear}-${String(endMonth).padStart(2, "0")}-${bounds[3].padStart(2, "0")}`;
  return today >= start && today <= end;
}

function eurospinOffer(card, query, location) {
  const title = decodeLidlHtml(card.match(/itemprop=["']name["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1]).replace(/\s+/g, " ").trim();
  const brand = decodeLidlHtml(card.match(/itemprop=["']brand["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
  if (!title || !eurospinProductMatches(title, brand, query)) return null;
  const validity = decodeLidlHtml(card.match(/class=["']date_current_promo["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
  if (validity && !eurospinOfferCurrentlyValid(validity)) return null;
  const priceText = decodeLidlHtml(card.match(/itemprop=["']price["'][^>]*>([\s\S]*?)<\/i>/i)?.[1]);
  const price = Number(priceText.replace(/[^\d,.-]/g, "").replace(",", "."));
  if (!Number.isFinite(price) || price <= 0) return null;
  const image = decodeLidlHtml(card.match(/itemprop=["']image["'][^>]*\bsrc=["']([^"']+)/i)?.[1]);
  const info = decodeLidlHtml(card.match(/class=["']i_price_info["'][^>]*>([\s\S]*?)<\/div>/i)?.[1])
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const unit = info.match(/([\d.,]+)\s*€\s*\/\s*(kg|l)\b/i);
  let unitPrice = unit ? Number(unit[1].replace(",", ".")) : undefined;
  let unitMeasure = unit?.[2]?.toUpperCase();
  const pack = info.match(/(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l|lt)\b/i);
  if (!unitPrice && pack) {
    const count = Number(pack[1] || 1);
    const amount = Number(pack[2].replace(",", "."));
    const measure = pack[3].toLowerCase();
    const quantity = count * amount / (measure === "g" || measure === "ml" ? 1000 : measure === "cl" ? 100 : 1);
    unitMeasure = /^(ml|cl|l|lt)$/.test(measure) ? "L" : "KG";
    if (quantity > 0) unitPrice = Number((price / quantity).toFixed(2));
  }
  const unitLabel = unitPrice && unitMeasure ? `€/${unitMeasure.toLowerCase()}` : undefined;
  const packText = pack ? pack[0] : "";
  return {
    code: String(image.match(/\/([^/]+)\.[a-z]+(?:\?|$)/i)?.[1] || `${title}-${brand}`),
    text: [[title, brand].filter(Boolean).join(" "), packText, `${formatEuro(price)} €`,
      unitPrice ? `${formatEuro(unitPrice)} ${unitLabel}` : "", "Offerta volantino Eurospin"].filter(Boolean).join(" · "),
    image, link: location.targetUrl, price, unitPrice, unitMeasure, unitLabel,
    validPeriod: validity || undefined
  };
}

async function searchEurospinOffers(location, query) {
  const response = await fetch(location.targetUrl, {
    headers: { Accept: "text/html" }, cf: { cacheTtl: 900, cacheEverything: true }
  });
  if (!response.ok) throw new Error(`Promozioni Eurospin ${response.status}`);
  const html = await response.text();
  if (html.length > 2000000) throw new Error("Pagina promozioni Eurospin troppo grande");
  const cards = [...html.matchAll(/<a\b[^>]*class=["'][^"']*sn_promo_grid_item[^"']*["'][\s\S]*?<\/a>/gi)]
    .map(match => match[0]);
  if (!cards.length) throw new Error("Prodotti promozionali Eurospin non disponibili");
  const offers = cards.map(card => eurospinOffer(card, query, location)).filter(Boolean)
    .filter((offer, index, all) => all.findIndex(item => item.code === offer.code) === index)
    .sort((a, b) => a.price - b.price);
  return {
    result: offers.map(offer => `${offer.text}\n${offer.image}\n${offer.link}`).join("\n---\n"),
    matches: offers.length, offers, finalUrl: location.targetUrl,
    pageTitle: `Offerte volantino ${location.storeName}`,
    flyersChecked: 1, flyerProducts: cards.length, sourceFormat: "eurospin-official-promotions"
  };
}

function decodeLidlHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&euro;/g, "€").replace(/<[^>]+>/g, " ").trim();
}

function lidlProductMatches(product, query) {
  const wanted = normalizeProductSearch(query).trim();
  if (!wanted) return false;
  const category = normalizeProductSearch(product.keyfacts?.wonCategoryPrimary || "");
  const analytics = normalizeProductSearch(product.keyfacts?.analyticsCategory || "");
  const groups = [
    [/^frutta$/, /\/la frutta(?:\/|$)|frutta a guscio/],
    [/^(verdura|verdure|ortaggi)$/, /\/verdure|frutta e verdura/],
    [/^ortofrutta$/, /frutta e verdura|\/la frutta|\/verdure/],
    [/^(carne|carni|pollame)$/, /carne|pollame|salumi/],
    [/^(pesce|pesci)$/, /pesce|frutti di mare/],
    [/^(latticini|formaggi|formaggio)$/, /formaggi|latticini/],
    [/^(bevande|bibite)$/, /bevande|bibite/],
    [/^(surgelati|gelati)$/, /congelat|surgelat|gelat/],
    [/^(detersivi|pulizia)$/, /pulizia|detersiv|cura della casa/],
    [/^(igiene|cosmetici)$/, /igiene|cosmetic|cura della persona/]
  ];
  const selected = groups.find(([pattern]) => pattern.test(wanted))?.[1];
  if (selected) return selected.test(category) || selected.test(analytics);
  if (wanted === "pasta" && /formagg|latticini|sughi|congelat/.test(category)) return false;
  const haystack = normalizeProductSearch(decodeLidlHtml([
    product.fullTitle, product.title, product.brand?.name, product.keyfacts?.description
  ].filter(Boolean).join(" ")));
  return wanted.split(/\s+/).filter(word => word.length > 2).every(word => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (word.length > 4 && /[aeio]$/.test(word)) {
      return new RegExp(`\\b${escaped.slice(0, -1)}[aeio]?\\b`).test(haystack);
    }
    return new RegExp(`\\b${escaped}\\b`).test(haystack);
  });
}

function lidlOffer(product, location) {
  const region = product.regionsV2?.[location.regionId]
    || Object.values(product.regionsV2 || {}).find(item => item?.isDefault)
    || Object.values(product.regionsV2 || {})[0];
  const regional = product.regionsPrices?.[region?.regionPriceId || "1"]
    || Object.values(product.regionsPrices || {})[0] || {};
  const plus = regional.currentLidlPlusPrice;
  const pricing = regional.currentPrice || plus?.price || product.price || {};
  const price = Number(pricing.price);
  const title = decodeLidlHtml(product.fullTitle || product.title);
  if (!title || !Number.isFinite(price) || price <= 0) return null;

  const now = Date.now();
  const starts = pricing.startDate ? Date.parse(pricing.startDate) : Number(product.storeStartDate || 0) * 1000;
  const ends = pricing.endDate ? Date.parse(pricing.endDate) : Number(product.storeEndDate || 0) * 1000;
  if ((Number.isFinite(starts) && starts > now) || (Number.isFinite(ends) && ends > 0 && ends < now)) return null;

  const packaging = decodeLidlHtml(pricing.packaging?.text || product.price?.packaging?.text || "");
  const weight = packaging.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l|lt)\b/i);
  let unitPrice;
  let unitMeasure;
  if (weight) {
    const amount = Number(weight[1].replace(",", "."));
    const measure = weight[2].toLowerCase();
    const quantity = amount / (measure === "g" || measure === "ml" ? 1000 : measure === "cl" ? 100 : 1);
    unitMeasure = /^(ml|cl|l|lt)$/.test(measure) ? "L" : "KG";
    if (quantity > 0) unitPrice = Number((price / quantity).toFixed(2));
  } else if (/\bal\s*kg\b/i.test(packaging)) {
    unitMeasure = "KG";
    unitPrice = price;
  } else if (/\bal\s*l(?:itro)?\b/i.test(packaging)) {
    unitMeasure = "L";
    unitPrice = price;
  } else {
    const base = decodeLidlHtml(pricing.basePrice?.text || "").match(/1\s*(kg|l)\s*=\s*(?:da\s*[\d.,]+\s*a\s*)?([\d.,]+)\s*€/i);
    if (base) { unitMeasure = base[1].toUpperCase(); unitPrice = Number(base[2].replace(",", ".")); }
  }

  const unitLabel = unitPrice ? `€/${unitMeasure.toLowerCase()}` : undefined;
  const unitText = unitPrice ? `${formatEuro(unitPrice)} ${unitLabel}` : "";
  return {
    code: String(product.productId || product.itemId || title),
    text: [title, packaging, `${formatEuro(price)} €`, unitText,
      plus && !regional.currentPrice ? "Offerta volantino Lidl Plus" : "Offerta volantino Lidl"].filter(Boolean).join(" · "),
    image: String(product.image || product.imageList_V1?.[0]?.image || ""),
    link: new URL(product.canonicalUrl || location.targetUrl, "https://www.lidl.it").href,
    price,
    unitPrice,
    unitMeasure,
    unitLabel,
    previousPrice: Number(pricing.oldPrice || pricing.discount?.deletedPrice || 0) || undefined,
    validUntil: pricing.endDate || undefined,
    lidlPlus: Boolean(plus && !regional.currentPrice)
  };
}

async function searchLidlOffers(location, query) {
  const homeResponse = await fetch("https://www.lidl.it/", {
    headers: { Accept: "text/html" }, cf: { cacheTtl: 900, cacheEverything: true }
  });
  if (!homeResponse.ok) throw new Error(`Offerte Lidl ${homeResponse.status}`);
  const home = await homeResponse.text();
  if (home.length > 1500000) throw new Error("Pagina offerte Lidl troppo grande");
  const campaignLinks = [...new Set([...home.matchAll(/href="(\/c\/[^"?#]+\/a\d+)"/g)]
    .map(match => decodeLidlHtml(match[1])))];
  const wanted = normalizeProductSearch(query);
  const relevant = campaignLinks.filter(path =>
    /lidl-plus|xxl|frutta-e-verdura|carne-e-pesce|super-offerte|mega-offerte|inflazione-zero/i.test(path));
  const priority = path => {
    if (/frutta|verdura|patat|pomodor|carot|mel|per[ae]|uva|pesche|banan/i.test(wanted))
      return /frutta-e-verdura/.test(path) ? 0 : /xxl/.test(path) ? 1 : 2;
    if (/carne|pesce|poll|salsicc|salamell|tonno|hamburger/i.test(wanted))
      return /carne-e-pesce/.test(path) ? 0 : /super-offerte/.test(path) ? 1 : 2;
    return /super-offerte|mega-offerte/.test(path) ? 0 : /lidl-plus/.test(path) ? 1 : 2;
  };
  relevant.sort((a, b) => priority(a) - priority(b));
  const pages = [home, ...(await Promise.allSettled(relevant.slice(0, 7).map(async path => {
    const response = await fetch(new URL(path, "https://www.lidl.it"), {
      headers: { Accept: "text/html" }, cf: { cacheTtl: 900, cacheEverything: true }
    });
    if (!response.ok) throw new Error(`Campagna Lidl ${response.status}`);
    const html = await response.text();
    if (html.length > 1500000) throw new Error("Campagna Lidl troppo grande");
    return html;
  }))).filter(result => result.status === "fulfilled").map(result => result.value)];

  const products = new Map();
  for (const html of pages) {
    for (const match of html.matchAll(/data-grid-data="([^"]+)"/g)) {
      try {
        const product = JSON.parse(decodeLidlHtml(match[1]));
        if (product.productId && !products.has(product.productId)) products.set(product.productId, product);
      } catch { /* Ignore malformed non-product fragments. */ }
    }
  }
  const offers = [...products.values()].filter(product => lidlProductMatches(product, query))
    .map(product => lidlOffer(product, location)).filter(Boolean)
    .sort((a, b) => a.price - b.price);
  return {
    result: offers.map(offer => `${offer.text}\n${offer.image}\n${offer.link}`).join("\n---\n"),
    matches: offers.length,
    offers,
    finalUrl: location.targetUrl,
    pageTitle: `Offerte volantino ${location.storeName}`,
    flyersChecked: pages.length,
    flyerProducts: products.size,
    sourceFormat: "lidl-official-campaigns"
  };
}

async function resolveMd(cap, radiusKm = 10) {
  const position = await geocodeItalianPostcode(cap);
  if (!position) return { locationApplied: false, nearby: false };

  const listUrl = new URL("https://www.mdspa.it/punti_vendita_admin/listnew.php");
  listUrl.searchParams.set("latitudine", String(position.lat));
  listUrl.searchParams.set("longitudine", String(position.lng));
  listUrl.searchParams.set("luogocercare", cap);
  const response = await fetch(listUrl, { headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error(`Ricerca punti vendita MD ${response.status}`);
  const html = await response.text();
  if (html.length > 1500000) throw new Error("Elenco punti vendita MD troppo grande");
  const ids = [...new Set([...html.matchAll(/\/(\d+)-[\w%-]+/g)].map(match => match[1]))].slice(0, 8);

  const details = await Promise.allSettled(ids.map(async id => {
    const result = await fetch("https://www.mdspa.it/punti_vendita_admin/get_pv.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ pv: id })
    });
    if (!result.ok) throw new Error(`Punto vendita MD ${result.status}`);
    const payload = await result.json();
    const store = payload?.pv;
    const lat = Number(store?.latitudine);
    const lng = Number(store?.longitudine);
    if (!store || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number(store.zona_id)) return null;
    return { ...store, distanceKm: haversineKm(position, { lat, lng }) };
  }));

  const ranked = details.filter(item => item.status === "fulfilled" && item.value)
    .map(item => item.value)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const store = ranked[0];
  if (!store || store.distanceKm > radiusKm) {
    return { locationApplied: true, nearby: false, nearestDistanceKm: store ? Number(store.distanceKm.toFixed(1)) : null };
  }

  return {
    locationApplied: true,
    nearby: true,
    storeId: String(store.id),
    storeName: `MD ${String(store.citta || "").trim()}`,
    storeAddress: [store.indirizzo, store.cap, store.citta].filter(Boolean).join(", "),
    distanceKm: Number(store.distanceKm.toFixed(1)),
    storeUrl: String(store.link_scheda || ""),
    targetUrl: `https://www.mdspa.it/sfogliatore/?id_pv=${encodeURIComponent(store.id)}`,
    validity: String(store.breve_zona || "")
  };
}

function normalizeProductSearch(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function mdProductMatches(product, query) {
  const wanted = normalizeProductSearch(query).trim();
  if (!wanted) return false;
  const groups = [
    [/^(frutta|verdura|ortofrutta|ortaggi)$/, /^ORTOFRUTTA$/i],
    [/^(carne|carni|pollame)$/, /^CARNI$/i],
    [/^(latticini|latte|formaggi|formaggio|salumi|uova|yogurt)$/, /^(FRESCO|GASTRONOMIA)$/i],
    [/^(bevande|bibite|acqua|birra|vino|vini)$/, /^BEVANDE$/i],
    [/^(surgelati|gelati|pesce)$/, /^FREDDO$/i],
    [/^(detersivi|detersivo|pulizia)$/, /^CURA CASA$/i],
    [/^(igiene|cosmetici)$/, /^CURA PERSONA$/i]
  ];
  const category = groups.find(([pattern]) => pattern.test(wanted))?.[1];
  if (category) return category.test(String(product.category || ""));
  const haystack = normalizeProductSearch([product.name, product.title, product.brand, product.description, product.section].join(" "));
  return wanted.split(/\s+/).filter(word => word.length > 2)
    .every(word => haystack.includes(word.length > 4 ? word.slice(0, -1) : word));
}

function mdOffer(product, flyerUrl) {
  const price = Number(product.priceOff || product.price);
  const title = String(product.title || product.name || "").trim();
  if (!title || !Number.isFinite(price) || price <= 0) return null;

  const weight = Number(product.weight || 0);
  const measure = String(product.weight_um || "").trim().toLowerCase();
  const divisor = measure === "g" || measure === "ml" ? 1000 : measure === "cl" ? 100 : 1;
  const quantity = weight / divisor;
  const unitMeasure = /^(ml|cl|l|lt)$/.test(measure) ? "L" : /^(g|kg)$/.test(measure) ? "KG" : "";
  const unitPrice = quantity > 0 && unitMeasure ? Number((price / quantity).toFixed(2)) : undefined;
  const imagePath = (Array.isArray(product.photos) ? product.photos : []).find(photo => photo.isDefault)?.imageUrl
    || product.photos?.[0]?.imageUrl || "";
  const name = [title, String(product.brand || "").trim()].filter(Boolean).join(" ");
  const weightText = weight > 0 && measure ? `${weight} ${measure}` : "";
  const unitText = unitPrice ? `${formatEuro(unitPrice)} €/${unitMeasure.toLowerCase()}` : "";

  return {
    code: String(product.idProduct || product.code || name),
    text: [name, weightText, `${formatEuro(price)} €`, unitText, "Offerta volantino"].filter(Boolean).join(" · "),
    image: imagePath ? new URL(imagePath, "https://volantino.mdspa.it").href : "",
    link: flyerUrl,
    price,
    unitPrice,
    unitMeasure: unitMeasure || undefined
  };
}

async function searchMdFlyer(location, query) {
  const localResponse = await fetch(location.targetUrl, { headers: { Accept: "text/html" } });
  if (!localResponse.ok) throw new Error(`Volantino locale MD ${localResponse.status}`);
  const localHtml = await localResponse.text();
  if (localHtml.length > 1500000) throw new Error("Pagina volantino MD troppo grande");
  const flyerCode = localHtml.match(/data-flyer-code=["']([a-z0-9_-]+)["']/i)?.[1];
  if (!flyerCode) throw new Error("Codice volantino locale MD non disponibile");

  // The service-volantino gateway redirects to this canonical HTML document.
  // Calling the gateway from Workers intermittently returns 502, while the
  // official destination consistently exposes the same local product feed.
  const flyerUrl = `https://volantino.mdspa.it/${encodeURIComponent(flyerCode)}.html`;
  const response = await fetch(flyerUrl, {
    headers: { Accept: "text/html,application/xhtml+xml", Referer: "https://www.mdspa.it/" }
  });
  if (!response.ok) throw new Error(`Catalogo offerte MD ${response.status}`);
  const html = await response.text();
  if (html.length > 5000000) throw new Error("Catalogo offerte MD troppo grande");
  const serialized = html.match(/\bvar\s+data\s*=\s*(\[[\s\S]*?\]);/)?.[1];
  if (!serialized) throw new Error("Prodotti volantino MD non disponibili");
  const products = JSON.parse(serialized);
  if (!Array.isArray(products)) throw new Error("Formato catalogo MD non valido");

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
  const offers = products.filter(product => {
    const starts = String(product.sellOutStart || "").slice(0, 10);
    const ends = String(product.sellOutEnd || "").slice(0, 10);
    return (!starts || starts <= today) && (!ends || ends >= today) && mdProductMatches(product, query);
  }).map(product => mdOffer(product, flyerUrl)).filter(Boolean)
    .sort((a, b) => a.price - b.price);

  return {
    result: offers.map(offer => `${offer.text}\n${offer.image}\n${offer.link}`).join("\n---\n"),
    matches: offers.length,
    offers,
    finalUrl: flyerUrl,
    pageTitle: `Offerte volantino ${location.storeName}`,
    flyersChecked: 1,
    flyerValidity: location.validity,
    flyerProducts: products.length
  };
}

async function resolveAldi(cap, radiusKm = 10) {
  const position = await geocodeItalianPostcode(cap);
  if (!position) return { locationApplied: false, nearby: false };
  const url = new URL(`https://locator.uberall.com/api/storefinders/${ALDI_STORE_FINDER_KEY}/locations`);
  url.searchParams.set("lat", String(position.lat));
  url.searchParams.set("lng", String(position.lng));
  url.searchParams.set("max", "20");
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Ricerca punti vendita ALDI ${response.status}`);
  const payload = await response.json();
  const stores = Array.isArray(payload?.response?.locations) ? payload.response.locations : [];
  const ranked = stores.filter(store => Number.isFinite(Number(store.lat)) && Number.isFinite(Number(store.lng)))
    .map(store => ({ ...store, distanceKm: haversineKm(position, { lat: Number(store.lat), lng: Number(store.lng) }) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const store = ranked[0];
  if (!store || store.distanceKm > radiusKm) {
    return { locationApplied: true, nearby: false, nearestDistanceKm: store ? Number(store.distanceKm.toFixed(1)) : null };
  }
  return {
    locationApplied: true,
    nearby: true,
    storeId: String(store.identifier || store.id),
    storeName: String(store.name || "ALDI"),
    storeAddress: [store.streetAndNumber, store.zip, store.city].filter(Boolean).join(", "),
    distanceKm: Number(store.distanceKm.toFixed(1)),
    storeUrl: "https://www.aldi.it/punti-vendita-e-orari-di-apertura"
  };
}

function aldiVerifiedOffer(contents, query, pageUrl, pageNumber) {
  // Aldi's search index contains complete page text, including ordinary
  // assortment pages. Never mistake the latter for promotional offers.
  if (!/(?:-\s*\d{1,2}\s*%|quantit[àa]\s+limitata|offert)/i.test(contents)) return null;
  const wanted = normalizeProductSearch(query).trim();
  const stems = wanted.split(/\s+/).filter(word => word.length > 2)
    .map(word => word.length > 4 ? word.slice(0, -1) : word);
  const normalized = normalizeProductSearch(contents);
  const position = normalized.indexOf(stems[0] || "");
  if (position < 0 || !stems.every(stem => normalized.includes(stem))) return null;

  const units = [...contents.matchAll(/(?:€|¤)\s*(\d+[,.]\d{2})\s*\/\s*(kg|litro|l)\b/gi)]
    .map(match => ({ value: Number(match[1].replace(",", ".")), measure: /^kg$/i.test(match[2]) ? "KG" : "L", index: match.index }));
  const quantities = [...contents.matchAll(/\b(\d+(?:[,.]\d+)?)\s*(kg|g|ml|l)\b/gi)]
    .map(match => {
      const value = Number(match[1].replace(",", "."));
      const measure = match[2].toLowerCase();
      return { value: measure === "g" || measure === "ml" ? value / 1000 : value,
        label: `${match[1]} ${measure}`, measure: measure === "ml" || measure === "l" ? "L" : "KG", index: match.index };
    });
  const prices = [...contents.matchAll(/\b(\d+[,.]\d{2})\b/g)]
    .map(match => ({ value: Number(match[1].replace(",", ".")), index: match.index }))
    .filter(price => !units.some(unit => Math.abs(unit.index - price.index) < 4));
  const candidates = [];
  for (const quantity of quantities) {
    for (const unit of units) {
      if (quantity.measure !== unit.measure) continue;
      const expected = Number((quantity.value * unit.value).toFixed(2));
      for (const price of prices) {
        if (Math.abs(price.value - expected) > 0.005 || price.value <= 0) continue;
        const score = Math.abs(quantity.index - position) * 2 + Math.abs(unit.index - position)
          + Math.abs(price.index - position);
        candidates.push({ price: price.value, unitPrice: unit.value, quantity, unit, score });
      }
    }
  }
  const candidate = candidates.sort((a, b) => a.score - b.score)[0];
  // A price is published only when the official page independently confirms it
  // through price = quantity × €/kg (or €/l).
  if (!candidate) return null;
  const escaped = stems[0].toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const titleMatch = contents.match(new RegExp(`(?:[A-ZÀ-Ü΄']{1,20}\\s+){0,4}[A-ZÀ-Ü]*${escaped}[A-ZÀ-Ü]*(?:\\s+[A-ZÀ-Ü΄']{2,20})?`));
  const title = String(titleMatch?.[0] || query).trim().replace(/\s+/g, " ");
  const unitText = `${formatEuro(candidate.unitPrice)} €/${candidate.unit.measure.toLowerCase()}`;
  return {
    code: `aldi-${pageNumber}-${normalizeProductSearch(title).replace(/\W+/g, "-")}`,
    text: [title, candidate.quantity.label, `${formatEuro(candidate.price)} €`, unitText, "Offerta volantino"].join(" · "),
    image: "",
    link: pageUrl,
    price: candidate.price,
    unitPrice: candidate.unitPrice,
    unitMeasure: candidate.unit.measure
  };
}

async function searchAldiFlyer(location, query) {
  const listingResponse = await fetch("https://www.aldi.it/volantino-online", { headers: { Accept: "text/html" } });
  if (!listingResponse.ok) throw new Error(`Volantini ALDI ${listingResponse.status}`);
  const listing = await listingResponse.text();
  if (listing.length > 1800000) throw new Error("Elenco volantini ALDI troppo grande");
  const links = [...new Set([...listing.matchAll(/https:\/\/volantino\.aldi\.it\/([^"'\s<>]+)\/page\/1/gi)]
    .map(match => match[1]).filter(slug => /offert/i.test(slug)))].slice(0, 2);
  if (!links.length) return { result: "", matches: 0, offers: [], finalUrl: "https://www.aldi.it/volantino-online", flyersChecked: 0 };
  const cleanQuery = String(query || "").trim().slice(0, 100);
  if (!cleanQuery) return { result: "", matches: 0, offers: [], finalUrl: "https://www.aldi.it/volantino-online", flyersChecked: links.length };
  // The official listing shows the currently valid flyer before future flyers.
  const slug = links[0];
  const searchUrl = new URL(`https://volantino.aldi.it/${slug}/search.json`);
  searchUrl.searchParams.set("q", cleanQuery);
  searchUrl.searchParams.set("sort", "_score desc");
  searchUrl.searchParams.set("return", "contents,_score,page_number");
  const response = await fetch(searchUrl, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Ricerca volantino ALDI ${response.status}`);
  const payload = await response.json();
  const hits = Array.isArray(payload.hits) ? payload.hits.slice(0, 20) : [];
  const offers = hits.map(hit => {
    const pageNumber = String(hit.fields?.page_number || "1");
    return aldiVerifiedOffer(String(hit.fields?.contents || ""), cleanQuery,
      `https://volantino.aldi.it/${slug}/page/${encodeURIComponent(pageNumber)}`, pageNumber);
  }).filter(Boolean).sort((a, b) => a.price - b.price);
  return {
    result: offers.map(offer => `${offer.text}\n${offer.link}`).join("\n---\n"),
    matches: offers.length,
    offers,
    finalUrl: `https://volantino.aldi.it/${slug}/page/1`,
    pageTitle: `Offerte volantino ${location.storeName}`,
    flyersChecked: 1,
    indexedPages: Number(payload.found || 0),
    sourceFormat: "indexed-flyer"
  };
}

async function resolveConad(cap, radiusKm = 10) {
  const position = await geocodeItalianPostcode(cap);
  if (!position) return { locationApplied: false, nearby: false };
  const response = await fetch("https://www.conad.it/api/corporate/it-it.retrievePointOfService.json", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ latitudine: position.lat, longitudine: position.lng, raggioRicerca: radiusKm,
      insegneId: [], serviziId: [], repartiId: [], apertura: [] })
  });
  if (!response.ok) throw new Error(`Ricerca punti vendita Conad ${response.status}`);
  const payload = await response.json();
  const stores = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const ranked = stores.map(store => {
    const distance = Number(store.distanza);
    const lat = Number(store.latitudine);
    const lng = Number(store.longitudine);
    const distanceKm = Number.isFinite(distance) && distance >= 0 ? distance
      : Number.isFinite(lat) && Number.isFinite(lng) ? haversineKm(position, { lat, lng }) : Infinity;
    return { ...store, distanceKm };
  }).filter(store => store.anacanId && Number(store.volantiniCount || 0) > 0)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const store = ranked[0];
  if (!store || store.distanceKm > radiusKm) {
    return { locationApplied: true, nearby: false, nearestDistanceKm: store ? Number(store.distanceKm.toFixed(1)) : null };
  }
  return {
    locationApplied: true,
    nearby: true,
    storeId: String(store.anacanId),
    storeName: String(store.pdvTitle || "Conad"),
    storeAddress: String(store.pdvAddress || ""),
    distanceKm: Number(store.distanceKm.toFixed(1)),
    storeUrl: String(store.pdvPlainUrl || "")
  };
}

const CONAD_PDF_NUMBER = "-?(?:\\d+\\.?\\d*|\\.\\d+)";
const CONAD_PDF_OPERATOR = new RegExp(`(${CONAD_PDF_NUMBER})\\s+(${CONAD_PDF_NUMBER})\\s+(${CONAD_PDF_NUMBER})\\s+(${CONAD_PDF_NUMBER})\\s+(${CONAD_PDF_NUMBER})\\s+(${CONAD_PDF_NUMBER})\\s+Tm|(${CONAD_PDF_NUMBER})\\s+(${CONAD_PDF_NUMBER})\\s+Td|(\\[(?:[^\\]\\\\]|\\\\[\\s\\S])*\\])\\s*TJ|(\\((?:[^()\\\\]|\\\\[\\s\\S])*\\))\\s*Tj|\\/[\\w-]+\\s+(${CONAD_PDF_NUMBER})\\s+Tf`, "g");
const CONAD_CATEGORY_WORDS = {
  frutta: ["frutt", "mela", "mele", "pera", "pere", "pesc", "nettari", "susin", "uva", "angur", "melon", "frag", "mirtil", "banana", "albicocc", "kiwi", "avocado", "ananas", "aranc", "limon"],
  verdura: ["verdur", "ortofrutt", "patat", "pomodor", "peperon", "cetriol", "lattug", "insalat", "zucchin", "melanzan", "carot", "cipoll", "fagiolin", "spinac", "finocch"],
  carne: ["carn", "pollo", "vitell", "manz", "bovin", "suin", "maial", "salsicc", "salamell", "hamburger", "tagliat", "fettin", "tacchin", "angus"],
  pesce: ["pesc", "tonn", "salmon", "merluzz", "orata", "branzin", "gamber", "sardin", "sgombr", "polpo"],
  latticini: ["latt", "yogurt", "mozzarell", "formagg", "ricott", "burro", "parmigian", "grana", "stracchin", "philadelphia"],
  bevande: ["acqua", "bibit", "coca", "succh", "birr", "vin", "bevanda", "aranciat", "nettare"]
};

function conadPdfString(value) {
  return value.replace(/\\([0-7]{1,3}|n|r|t|b|f|[()\\]|\r?\n)/g, (_, escaped) => {
    if (/^[0-7]/.test(escaped)) {
      const code = parseInt(escaped, 8);
      return code === 128 ? "€" : String.fromCharCode(code);
    }
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[escaped]
      ?? (escaped.includes("\n") ? "" : escaped);
  }).replace(/\s+/g, " ").trim();
}

function conadPdfRuns(content) {
  let x = 0, y = 0, scaleX = 1, scaleY = 1, fontSize = 1;
  const runs = [];
  for (const item of content.matchAll(CONAD_PDF_OPERATOR)) {
    if (item[11] !== undefined) {
      fontSize = Number(item[11]) || 1;
      continue;
    }
    if (item[1] !== undefined) {
      scaleX = Number(item[1]); scaleY = Number(item[4]); x = Number(item[5]); y = Number(item[6]);
      continue;
    }
    if (item[7] !== undefined) {
      x += Number(item[7]) * scaleX; y += Number(item[8]) * scaleY;
      continue;
    }
    const parts = item[9] ? [...item[9].matchAll(/\(((?:[^()\\]|\\[\s\S])*)\)/g)].map(part => part[1])
      : [item[10].slice(1, -1)];
    const text = conadPdfString(parts.join(""));
    if (text) runs.push({ x, y, size: Math.abs(scaleY) * fontSize, text });
    if (runs.length >= 2500) break;
  }
  return runs;
}

function conadQueryMatches(value, query) {
  const text = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const terms = String(query || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/).filter(term => term.length >= 3);
  if (!terms.length) return false;
  if (terms.length === 1 && CONAD_CATEGORY_WORDS[terms[0]]) {
    return CONAD_CATEGORY_WORDS[terms[0]].some(term => new RegExp(`\\b${term}`).test(text));
  }
  return terms.every(term => {
    const stem = term.length > 4 && /[aeiou]$/.test(term) ? term.slice(0, -1) : term;
    return new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[aeiou])?\\b`).test(text);
  });
}

function conadMoneyRuns(runs) {
  const prices = [];
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    if (/\/\s*(?:kg|l|lt|litro|conf|pz)/i.test(run.text) || run.size < 15) continue;
    const direct = run.text.match(/^€?\s*(\d{1,3}[,.]\d{2})\s*€?$/);
    if (direct) {
      prices.push({ ...run, price: Number(direct[1].replace(",", ".")) });
      continue;
    }
    if (!/^\d{1,3}$/.test(run.text) || run.size < 25) continue;
    const cents = runs.find(other => /^,\d{2}$/.test(other.text)
      && Math.abs(other.y - run.y) <= 35 && other.x > run.x && other.x - run.x <= 140);
    if (cents) {
      prices.push({ ...run, price: Number(`${run.text}.${cents.text.slice(1)}`) });
      continue;
    }
    const comma = runs.find(other => other.text === "," && Math.abs(other.y - run.y) <= 35
      && other.x > run.x && other.x - run.x <= 140);
    const splitCents = comma && runs.find(other => /^\d{2}$/.test(other.text)
      && Math.abs(other.y - comma.y) <= 3 && other.x > comma.x && other.x - comma.x <= 30);
    if (splitCents) prices.push({ ...run, price: Number(`${run.text}.${splitCents.text}`) });
  }
  return prices.filter((price, index) => price.price > 0 && price.price < 1000
    && prices.findIndex(other => other.price === price.price
      && Math.abs(other.x - price.x) < 3 && Math.abs(other.y - price.y) < 3) === index);
}

function conadOfferForRun(run, runs, prices, query, pdfUrl, pageNumber) {
  if (run.size < 7 || run.text.length > 100 || /offerta valida|catalogo|punti vendita|condizioni|spesaonline/i.test(run.text)) return null;
  if (!conadQueryMatches(run.text, query)) return null;
  const candidates = prices.map(price => {
    const dx = price.x - run.x;
    const dy = run.y - price.y;
    if (Math.abs(dx) > 190 || dy < -45 || dy > 285) return null;
    const score = Math.abs(dx) * 1.15 + Math.abs(dy) * 0.8 + (dx < -125 ? 55 : 0) + (dy < -15 ? 60 : 0);
    return { price, score };
  }).filter(Boolean).sort((a, b) => a.score - b.score);
  if (!candidates.length) return null;
  const selected = candidates[0].price;
  const details = runs.filter(other => other !== run && other.size >= 7 && other.size <= Math.max(run.size * 1.35, 20)
    && Math.abs(other.x - run.x) <= 75 && other.y <= run.y + 2 && other.y > selected.y - 20
    && !/^€|^\/|^,\d|^\d{1,3}$|offerta|titolari|origine|cat\./i.test(other.text))
    .sort((a, b) => b.y - a.y).slice(0, 5);
  const nameParts = [run.text];
  for (const detail of details) {
    if (detail.text === run.text || nameParts.some(part => part === detail.text)) continue;
    if (/^(?:confezione\s*)?(?:\d+[,.]?\d*\s*(?:x\s*\d+)?\s*(?:kg|g|ml|cl|l|lt))\b/i.test(detail.text)) continue;
    if (detail.text.length <= 45 && detail.y > selected.y + 3) nameParts.push(detail.text);
    if (nameParts.length >= 3) break;
  }
  const nearby = runs.filter(other => Math.abs(other.x - selected.x) <= 155 && Math.abs(other.y - selected.y) <= 135);
  const unit = nearby.map(other => ({ match: other.text.match(/(?:€\s*)?\/\s*(kg|l|lt)\s*(\d+[,.]\d{2})/i),
    distance: Math.abs(other.x - selected.x) + Math.abs(other.y - selected.y) * 0.7 }))
    .filter(item => item.match).sort((a, b) => a.distance - b.distance)[0]?.match;
  const weightLine = [...details, ...runs.filter(other => Math.abs(other.x - run.x) <= 145
    && other.y <= run.y + 3 && other.y >= selected.y - 8)]
    .filter(other => /(?:confezione\s*)?\d+[,.]?\d*\s*(?:x\s*\d+\s*)?(?:kg|g|ml|cl|l|lt)\b/i.test(other.text))
    .sort((a, b) => Math.abs(a.x - run.x) - Math.abs(b.x - run.x))[0]?.text;
  let unitPrice = unit ? Number(unit[2].replace(",", ".")) : null;
  let unitLabel = unit ? unit[1].toLowerCase().startsWith("l") ? "€/l" : "€/kg" : "";
  if (!unitPrice && weightLine) {
    const weight = weightLine.match(/(\d+[,.]?\d*)\s*(?:x\s*(\d+[,.]?\d*)\s*)?(kg|g|ml|cl|l|lt)\b/i);
    if (weight) {
      const amount = Number(weight[1].replace(",", ".")) * Number((weight[2] || "1").replace(",", "."));
      const measure = weight[3].toLowerCase();
      const base = measure === "g" || measure === "ml" ? amount / 1000 : measure === "cl" ? amount / 100 : amount;
      if (base > 0) { unitPrice = Number((selected.price / base).toFixed(2)); unitLabel = /ml|cl|^l/.test(measure) ? "€/l" : "€/kg"; }
    }
  }
  if (!unitPrice && nearby.some(other => /^\/?\s*kg\s*$|^€\s*\/\s*kg\s*$/i.test(other.text))) {
    unitPrice = selected.price; unitLabel = "€/kg";
  }
  const name = nameParts.join(" ").replace(/\s+/g, " ").trim();
  const displayPrice = selected.price.toFixed(2).replace(".", ",");
  const displayUnit = unitPrice ? ` · ${unitPrice.toFixed(2).replace(".", ",")} ${unitLabel}` : "";
  return { code: `conad-pdf-${pageNumber}-${Math.round(selected.x)}-${Math.round(selected.y)}-${displayPrice}`,
    name, text: `${name}${weightLine ? ` · ${weightLine}` : ""} · ${displayPrice} €${displayUnit}`,
    price: selected.price, unitPrice, unitLabel, image: "", link: `${pdfUrl}#page=${pageNumber}`, pageNumber };
}

async function searchConadPdfFlyer(pdfUrl, query) {
  const response = await fetch(pdfUrl, { headers: { Accept: "application/pdf" } });
  if (!response.ok) throw new Error(`PDF volantino Conad ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > 30000000) throw new Error("Volantino Conad troppo grande");
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.length > 30000000) throw new Error("Volantino Conad troppo grande");
  const raw = new TextDecoder("latin1").decode(buffer);
  const objects = new Map();
  for (const object of raw.matchAll(/(?:^|[\r\n])(\d+)\s+\d+\s+obj\b([\s\S]*?)\bendobj\b/g)) {
    const body = object[2];
    objects.set(object[1], { body, offset: object.index + object[0].indexOf(body) });
  }
  for (const object of [...objects.values()]) {
    const marker = object.body.indexOf("stream");
    const header = object.body.slice(0, marker < 0 ? 3000 : marker);
    if (marker < 0 || !/\/Type\s*\/ObjStm\b/.test(header)) continue;
    let start = object.offset + marker + 6;
    if (buffer[start] === 13) start++;
    if (buffer[start] === 10) start++;
    const length = Number(header.match(/\/Length\s+(\d+)/)?.[1] || 0);
    const first = Number(header.match(/\/First\s+(\d+)/)?.[1] || 0);
    const count = Number(header.match(/\/N\s+(\d+)/)?.[1] || 0);
    if (!length || !first || !count || length > 2000000 || count > 1000) continue;
    try {
      const bytes = /\/FlateDecode/.test(header) ? inflateSync(buffer.subarray(start, start + length))
        : buffer.subarray(start, start + length);
      if (bytes.length > 4000000 || first > bytes.length) continue;
      const decoded = new TextDecoder("latin1").decode(bytes);
      const pairs = [...decoded.slice(0, first).matchAll(/(\d+)\s+(\d+)/g)].slice(0, count);
      for (let index = 0; index < pairs.length; index++) {
        const from = first + Number(pairs[index][2]);
        const to = index + 1 < pairs.length ? first + Number(pairs[index + 1][2]) : decoded.length;
        objects.set(pairs[index][1], { body: decoded.slice(from, to), offset: -1 });
      }
    } catch { continue; }
  }
  const pages = [];
  for (const object of objects.values()) {
    const body = object.body;
    const header = body.slice(0, body.indexOf("stream") < 0 ? 3000 : body.indexOf("stream"));
    if (!/\/Type\s*\/Page\b/.test(header)) continue;
    const refs = header.match(/\/Contents\s*\[([^\]]+)\]/)?.[1] || header.match(/\/Contents\s+(\d+\s+\d+\s+R)/)?.[1] || "";
    pages.push([...refs.matchAll(/(\d+)\s+\d+\s+R/g)].map(reference => reference[1]));
  }
  const offers = [];
  for (let pageIndex = 0; pageIndex < Math.min(pages.length, 28); pageIndex++) {
    const runs = [];
    for (const id of pages[pageIndex]) {
      const object = objects.get(id);
      if (!object) continue;
      const marker = object.body.indexOf("stream");
      if (marker < 0) continue;
      const header = object.body.slice(0, marker);
      let start = object.offset + marker + 6;
      if (buffer[start] === 13) start++;
      if (buffer[start] === 10) start++;
      const reference = header.match(/\/Length\s+(\d+)(?:\s+(\d+)\s+R)?/);
      const length = reference?.[2]
        ? Number(objects.get(reference[1])?.body.match(/^\s*(\d+)/)?.[1] || 0)
        : Number(reference?.[1] || 0);
      const end = length ? start + length : raw.indexOf("endstream", start);
      if (end <= start || end - start > 600000) continue;
      try {
        const decoded = /\/FlateDecode/.test(header) ? inflateSync(buffer.subarray(start, end)) : buffer.subarray(start, end);
        if (decoded.length > 1200000) continue;
        runs.push(...conadPdfRuns(new TextDecoder("latin1").decode(decoded)));
      } catch { continue; }
    }
    const matches = runs.filter(run => conadQueryMatches(run.text, query));
    if (!matches.length) continue;
    const prices = conadMoneyRuns(runs);
    for (const run of matches) {
      const offer = conadOfferForRun(run, runs, prices, query, pdfUrl, pageIndex + 1);
      if (offer && !offers.some(previous => previous.code === offer.code)) offers.push(offer);
      if (offers.length >= 24) return { offers, pagesChecked: pageIndex + 1, totalPages: pages.length };
    }
  }
  return { offers, pagesChecked: pages.length, totalPages: pages.length };
}

async function searchConadFlyers(location, query) {
  const url = new URL("https://www.conad.it/api/corporate/it-it.flyers.json");
  url.searchParams.set("anacanId", location.storeId);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Volantini Conad ${response.status}`);
  const payload = await response.json();
  const allFlyers = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const now = Date.now();
  const flyers = allFlyers.filter(flyer => {
    const from = Number(flyer.validFrom || 0);
    const to = Number(flyer.validTo || 0);
    return (!from || from <= now) && (!to || to + 86400000 > now);
  });
  const structured = flyers.filter(flyer => flyer.hasDisaggregated && Number(flyer.disTotalProducts || 0) > 0 && flyer.link?.href);
  const cleanQuery = String(query || "").trim().slice(0, 100);
  const offers = [];
  for (const flyer of structured.slice(0, 3)) {
    const page = await fetch(flyer.link.href, { headers: { Accept: "text/html" } });
    if (!page.ok) continue;
    const html = await page.text();
    if (html.length > 3000000) continue;
    const extracted = directExtract(html, cleanQuery);
    for (const offer of extracted.offers) {
      const amount = offer.text.match(/(\d+[,.]\d{2})\s*€/);
      if (!amount) continue;
      offers.push({ ...offer, code: `${flyer.disaggregatedId}-${offer.text}`, link: flyer.link.href,
        price: Number(amount[1].replace(",", ".")) });
    }
  }
  let pdfPagesChecked = 0;
  let readablePdfFlyers = 0;
  if (cleanQuery && !offers.length) {
    const produce = /frutta|verdura|ortofrutta|patat|pomodor|peperon|melone|pesche|uva|fragol|zucchin|lattug|insalat|cetriol|anguri/i.test(cleanQuery);
    const pdfFlyers = flyers.filter(flyer => flyer.pdfUrl && !/parafarmacia|catalogo|premio|conad card/i.test(String(flyer.title || flyer.name || "")))
      .sort((a, b) => produce ? Number(/ortofrutt/i.test(String(b.title || b.name || "")))
        - Number(/ortofrutt/i.test(String(a.title || a.name || ""))) : 0);
    for (const flyer of pdfFlyers.slice(0, 2)) {
      try {
        const extracted = await searchConadPdfFlyer(String(flyer.pdfUrl), cleanQuery);
        readablePdfFlyers++;
        pdfPagesChecked += extracted.pagesChecked;
        offers.push(...extracted.offers);
        if (offers.length) break;
      } catch (error) {
        console.warn("conad_pdf_flyer_failed", { storeId: location.storeId, message: error.message });
      }
    }
  }
  const unique = offers.filter((offer, index) => offers.findIndex(item => item.code === offer.code) === index)
    .sort((a, b) => a.price - b.price);
  return {
    result: unique.map(offer => `${offer.text}\n${offer.link}`).join("\n---\n"),
    matches: unique.length,
    offers: unique,
    finalUrl: flyers[0]?.link?.href || location.storeUrl,
    pageTitle: `Offerte volantino ${location.storeName}`,
    flyersChecked: flyers.length,
    structuredFlyers: structured.length,
    readablePdfFlyers,
    pdfPagesChecked,
    sourceFormat: structured.length ? "structured" : readablePdfFlyers ? "pdf-extracted" : flyers.length ? "pdf" : "none"
  };
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
    storeAbbrev: String(store.abbrev).toUpperCase(),
    storeName: store.description || store.name || "Esselunga",
    storeAddress: [store.address, store.zipCode, store.city, store.province].filter(Boolean).join(", "),
    distanceKm: Number(store.distanceKm.toFixed(1)),
    storeUrl: targetUrl,
    targetUrl
  };
}

function esselungaDigitalFlyers(html, baseUrl, storeAbbrev) {
  const links = [];
  const pattern = /href=["']([^"']*\/volantino-digitale\.[^"']*\.([a-z0-9]+)\.(\d+)\.html)["']/gi;
  for (const match of html.matchAll(pattern)) {
    if (match[2].toUpperCase() !== storeAbbrev) continue;
    const url = new URL(match[1], baseUrl).href;
    if (!links.some(link => link.promoCode === match[3])) links.push({ url, promoCode: match[3] });
    if (links.length >= 8) break;
  }
  return links;
}

function formatEuro(value) {
  return Number(value).toFixed(2).replace(".", ",");
}

function esselungaCategoryMatcher(query) {
  const wanted = String(query || "").trim().toLowerCase();
  const groups = [
    [/^(frutta|verdura|ortofrutta|ortaggi)$/, /frutta|verdura/i],
    [/^(carne|carni|pollame)$/, /^carne$/i],
    [/^(pesce|sushi)$/, /^pesce/i],
    [/^(latticini|latte|formaggi|formaggio|salumi|uova|yogurt)$/, /^latticini/i],
    [/^(pane|panini|pasticceria)$/, /^pane e pasticceria/i],
    [/^(pasta|riso|gnocchi)$/, /^(confezionati alimentari|gastronomia)/i],
    [/^(acqua|birra|bibite|bevande)$/, /^acqua, birra/i],
    [/^(vino|vini|liquori)$/, /^vini e liquori/i],
    [/^(surgelati|gelati)$/, /^surgelati/i],
    [/^(detersivi|detersivo|pulizia)$/, /^cura casa/i],
    [/^(igiene|cosmetici)$/, /^igiene/i],
    [/^(animali|cane|gatto)$/, /^amici animali/i]
  ];
  return groups.find(([pattern]) => pattern.test(wanted))?.[1] || null;
}

async function esselungaCategoryCodes(storeAbbrev, categoryMatcher) {
  if (!categoryMatcher) return null;
  const url = `https://www.esselunga.it/services/istituzionale35/digital-grid.condition:menu.abbrev:${encodeURIComponent(storeAbbrev)}.json`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  const menu = await response.json();
  const byPromotion = new Map();
  for (const promotion of Array.isArray(menu.categorie) ? menu.categorie : []) {
    const promoCode = String(promotion.attributi?.codGruppoTestataPromo || "");
    if (!promoCode) continue;
    const codes = (Array.isArray(promotion.categorie) ? promotion.categorie : [])
      .filter(category => categoryMatcher.test(String(category.nome || "")))
      .map(category => String(category.attributi?.codCategoria1L || "").split(".")[0])
      .filter(Boolean);
    if (codes.length) byPromotion.set(promoCode, codes.join("|"));
  }
  return byPromotion;
}

function esselungaOffer(product, flyerUrl) {
  const flyerFlags = Array.isArray(product.promozioni_flgVolantino) ? product.promozioni_flgVolantino : [];
  const index = flyerFlags.findIndex(flag => flag === true);
  if (index < 0) return null;
  const promoPrices = Array.isArray(product.promozioni_prezzoPromo) ? product.promozioni_prezzoPromo : [];
  const price = Number(promoPrices[index] ?? promoPrices[0]);
  const title = String(product.title || "").trim();
  if (!title || !Number.isFinite(price) || price <= 0) return null;

  const advertisedUnits = Array.isArray(product.promozioni_prezzoPromoAl) ? product.promozioni_prezzoPromoAl : [];
  const advertisedMeasures = Array.isArray(product.promozioni_misuraPrezzoPromoAl) ? product.promozioni_misuraPrezzoPromoAl : [];
  let unitPrice = Number(advertisedUnits[index] ?? advertisedUnits[0] ?? 0);
  let unitMeasure = String(advertisedMeasures[index] ?? advertisedMeasures[0] ?? product.misuraPrezzoAl ?? "").toUpperCase();
  if (unitMeasure === "LT") unitMeasure = "L";
  if ((!Number.isFinite(unitPrice) || unitPrice <= 0) && /\bal\s*kg\b/i.test(title)) {
    unitPrice = price;
    unitMeasure = "KG";
  }
  if ((!Number.isFinite(unitPrice) || unitPrice <= 0)) {
    const weight = title.match(/\b(\d+(?:[,.]\d+)?)\s*(kg|g|l|ml)\b/i);
    if (weight) {
      const amount = Number(weight[1].replace(",", "."));
      const measure = weight[2].toLowerCase();
      const quantity = measure === "g" || measure === "ml" ? amount / 1000 : amount;
      if (quantity > 0) {
        unitPrice = price / quantity;
        unitMeasure = measure === "l" || measure === "ml" ? "L" : "KG";
      }
    }
  }
  const unitText = Number.isFinite(unitPrice) && unitPrice > 0 && unitMeasure
    ? `${formatEuro(unitPrice)} €/${unitMeasure.toLowerCase()}`
    : "";
  const mechanic = String(product.promozioni_desMeccanica?.[index] ?? product.promozioni_desMeccanica?.[0] ?? "Offerta volantino").trim();
  return {
    code: String(product.code || product.id || title),
    text: [title, `${formatEuro(price)} €`, unitText, mechanic].filter(Boolean).join(" · "),
    image: String(product.imgUrl || ""),
    link: flyerUrl,
    price,
    unitPrice: Number.isFinite(unitPrice) && unitPrice > 0 ? Number(unitPrice.toFixed(2)) : undefined,
    unitMeasure: unitMeasure || undefined
  };
}

async function searchEsselungaFlyer(location, query) {
  const response = await fetch(location.targetUrl, { headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error(`Volantino Esselunga ${response.status}`);
  const html = await response.text();
  if (html.length > 1500000) throw new Error("Volantino Esselunga troppo grande");
  const flyers = esselungaDigitalFlyers(html, response.url || location.targetUrl, location.storeAbbrev);
  if (!flyers.length) return { result: "", matches: 0, offers: [], finalUrl: response.url || location.targetUrl, pageTitle: "Volantini Esselunga", flyersChecked: 0 };

  const cleanQuery = String(query || "").trim().slice(0, 100);
  if (!cleanQuery) return { result: "", matches: 0, offers: [], finalUrl: response.url || location.targetUrl, pageTitle: "Volantini Esselunga", flyersChecked: flyers.length };
  const categoryCodes = await esselungaCategoryCodes(location.storeAbbrev, esselungaCategoryMatcher(cleanQuery));

  const readFlyer = async flyer => {
    const categoryCode = categoryCodes?.get(flyer.promoCode);
    if (categoryCodes && !categoryCode) return [];
    const readPage = async page => {
      const selectors = [
        ["condition", "basic"],
        ["abbrev", location.storeAbbrev],
        ["codPromo", flyer.promoCode],
        ["q", cleanQuery],
        ["page", String(page)],
        ["rows", "80"],
        ...(categoryCode ? [["category", categoryCode]] : [])
      ].map(([name, value]) => `.${name}:${encodeURIComponent(value)}`).join("");
      const apiUrl = `https://www.esselunga.it/services/istituzionale35/digital-grid${selectors}.json`;
      const apiResponse = await fetch(apiUrl, { headers: { Accept: "application/json", Referer: flyer.url } });
      if (!apiResponse.ok) throw new Error(`Ricerca Esselunga ${apiResponse.status}`);
      const payload = await apiResponse.json();
      return { total: Number(payload.item_found || 0), items: Array.isArray(payload.items) ? payload.items : [] };
    };
    const first = await readPage(0);
    const products = [...first.items];
    if (first.total > first.items.length && first.items.length >= 80) {
      const second = await readPage(1);
      products.push(...second.items);
    }
    return products.map(product => esselungaOffer(product, flyer.url)).filter(Boolean);
  };

  const settled = await Promise.allSettled(flyers.map(readFlyer));
  const successful = settled.filter(result => result.status === "fulfilled");
  if (!successful.length) throw new Error("Ricerca offerte Esselunga non disponibile");
  const byProduct = new Map();
  for (const result of successful) {
    for (const offer of result.value) {
      const current = byProduct.get(offer.code);
      if (!current || offer.price < current.price) byProduct.set(offer.code, offer);
    }
  }
  const offers = [...byProduct.values()].sort((a, b) => a.price - b.price);
  return {
    result: offers.map(offer => `${offer.text}\n${offer.image}\n${offer.link}`).join("\n---\n"),
    matches: offers.length,
    offers,
    finalUrl: response.url || location.targetUrl,
    pageTitle: `Offerte volantino ${location.storeName}`,
    flyersChecked: successful.length
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
    if (request.method !== "POST") return json({ ok: true, service: "SpesaMeno adapters", version: 24 });
    let browser;
    try {
      const body = await request.json();
      const requested = new URL(body.url);
      if (requested.protocol !== "https:" || !allowedHost(requested.hostname)) return json({ error: "Sito non autorizzato" }, 403);
      const adapter = adapterFor(requested.hostname);
      let target = new URL(adapter?.url || requested.href);
      let directLocation = null;
      if (adapter?.storeFlow === "iperal") {
        const radius = Math.min(100, Math.max(1, Number(body.radius || body.radiusKm || 10)));
        directLocation = await resolveIperal(String(body.cap || ""), radius);
        if (!directLocation.nearby) {
          return json({ success: true, chainAdapter: "iperal.it", locationApplied: directLocation.locationApplied,
            nearbyStore: false, nearestDistanceKm: directLocation.nearestDistanceKm ?? null,
            result: "", matches: 0, offers: [], finalUrl: adapter.url, pageTitle: "" });
        }
        const extracted = await searchIperalOffers(directLocation, String(body.query || "").slice(0, 100));
        return json({ success: true, chainAdapter: "iperal.it", locationApplied: true, nearbyStore: true,
          storeName: directLocation.storeName, storeAddress: directLocation.storeAddress,
          distanceKm: directLocation.distanceKm, storeUrl: directLocation.storeUrl, ...extracted });
      }
      if (adapter?.storeFlow === "eurospin") {
        const radius = Math.min(100, Math.max(1, Number(body.radius || body.radiusKm || 10)));
        directLocation = await resolveEurospin(String(body.cap || ""), radius);
        if (!directLocation.nearby) {
          return json({ success: true, chainAdapter: "eurospin.it", locationApplied: directLocation.locationApplied,
            nearbyStore: false, nearestDistanceKm: directLocation.nearestDistanceKm ?? null,
            result: "", matches: 0, offers: [], finalUrl: adapter.url, pageTitle: "" });
        }
        const extracted = await searchEurospinOffers(directLocation, String(body.query || "").slice(0, 100));
        return json({ success: true, chainAdapter: "eurospin.it", locationApplied: true, nearbyStore: true,
          storeName: directLocation.storeName, storeAddress: directLocation.storeAddress,
          distanceKm: directLocation.distanceKm, storeUrl: directLocation.storeUrl, ...extracted });
      }
      if (adapter?.storeFlow === "lidl") {
        const radius = Math.min(100, Math.max(1, Number(body.radius || body.radiusKm || 10)));
        directLocation = await resolveLidl(String(body.cap || ""), radius);
        if (!directLocation.nearby) {
          return json({ success: true, chainAdapter: "lidl.it", locationApplied: directLocation.locationApplied,
            nearbyStore: false, nearestDistanceKm: directLocation.nearestDistanceKm ?? null,
            result: "", matches: 0, offers: [], finalUrl: adapter.url, pageTitle: "" });
        }
        const extracted = await searchLidlOffers(directLocation, String(body.query || "").slice(0, 100));
        return json({ success: true, chainAdapter: "lidl.it", locationApplied: true, nearbyStore: true,
          storeName: directLocation.storeName, storeAddress: directLocation.storeAddress,
          distanceKm: directLocation.distanceKm, storeUrl: directLocation.storeUrl, ...extracted });
      }
      if (adapter?.storeFlow === "aldi") {
        const radius = Math.min(100, Math.max(1, Number(body.radius || body.radiusKm || 10)));
        directLocation = await resolveAldi(String(body.cap || ""), radius);
        if (!directLocation.nearby) {
          return json({ success: true, chainAdapter: "aldi.it", locationApplied: directLocation.locationApplied,
            nearbyStore: false, nearestDistanceKm: directLocation.nearestDistanceKm ?? null,
            result: "", matches: 0, offers: [], finalUrl: adapter.url, pageTitle: "" });
        }
        const extracted = await searchAldiFlyer(directLocation, String(body.query || "").slice(0, 100));
        return json({ success: true, chainAdapter: "aldi.it", locationApplied: true, nearbyStore: true,
          storeName: directLocation.storeName, storeAddress: directLocation.storeAddress,
          distanceKm: directLocation.distanceKm, storeUrl: directLocation.storeUrl, ...extracted });
      }
      if (adapter?.storeFlow === "md") {
        const radius = Math.min(100, Math.max(1, Number(body.radius || body.radiusKm || 10)));
        directLocation = await resolveMd(String(body.cap || ""), radius);
        if (!directLocation.nearby) {
          return json({ success: true, chainAdapter: "mdspa.it", locationApplied: directLocation.locationApplied,
            nearbyStore: false, nearestDistanceKm: directLocation.nearestDistanceKm ?? null,
            result: "", matches: 0, offers: [], finalUrl: adapter.url, pageTitle: "" });
        }
        const extracted = await searchMdFlyer(directLocation, String(body.query || "").slice(0, 100));
        return json({ success: true, chainAdapter: "mdspa.it", locationApplied: true, nearbyStore: true,
          storeName: directLocation.storeName, storeAddress: directLocation.storeAddress,
          distanceKm: directLocation.distanceKm, storeUrl: directLocation.storeUrl, ...extracted });
      }
      if (adapter?.storeFlow === "conad") {
        const radius = Math.min(100, Math.max(1, Number(body.radius || body.radiusKm || 10)));
        directLocation = await resolveConad(String(body.cap || ""), radius);
        if (!directLocation.nearby) {
          return json({ success: true, chainAdapter: "conad.it", locationApplied: directLocation.locationApplied,
            nearbyStore: false, nearestDistanceKm: directLocation.nearestDistanceKm ?? null,
            result: "", matches: 0, offers: [], finalUrl: adapter.url, pageTitle: "" });
        }
        const extracted = await searchConadFlyers(directLocation, String(body.query || "").slice(0, 100));
        return json({ success: true, chainAdapter: "conad.it", locationApplied: true, nearbyStore: true,
          storeName: directLocation.storeName, storeAddress: directLocation.storeAddress,
          distanceKm: directLocation.distanceKm, storeUrl: directLocation.storeUrl, ...extracted });
      }
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
        const extracted = await searchEsselungaFlyer(directLocation, String(body.query || ""));
        return json({
          success: true,
          chainAdapter: "esselunga.it",
          locationApplied: true,
          nearbyStore: true,
          storeName: directLocation.storeName,
          storeAddress: directLocation.storeAddress,
          distanceKm: directLocation.distanceKm,
          storeUrl: directLocation.storeUrl,
          ...extracted
        });
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

// SpesaMeno: adattatori aggiuntivi per volantini ufficiali.
if (!ROOT_HOSTS.includes("maxidi.it")) ROOT_HOSTS.push("maxidi.it");

Object.assign(ADAPTERS, {
  "rossettogroup.it": {
    url: "https://rossettogroup.it/prezzi-rossetto-in-corso/",
    wait: 4500
  },
  "supersigma.com": {
    // Il sito principale reindirizza il browser automatico alla pagina
    // generica. Il volantino locale ufficiale espone invece prodotti, prezzi,
    // unita di misura e fotografie durante il caricamento della pagina.
    url: "https://digitalflyers-ceu.supersigma.com/punti-vendita/sigma-di-brescia-via-livorno/promozioni/sigma-promo-17",
    wait: 12000
  },
  "d-piu.com": {
    url: "https://dpiu.maxidi.it/punti-vendita",
    wait: 6500
  },
  "maxidi.it": {
    url: "https://dpiu.maxidi.it/punti-vendita",
    wait: 6500
  },
  "latuaspesa.com": {
    url: "https://www.latuaspesa.com/category/articoli-in-promozione",
    wait: 6500
  }
});
