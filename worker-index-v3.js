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
// Public store-finder identifier published on Aldi's official Italian website.
const ALDI_STORE_FINDER_KEY = "J8f9erNQcUhg1nmo5Bhp8wy2A6mQkK";

const ADAPTERS = {
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
  const offers = [];
  for (const flyer of structured.slice(0, 3)) {
    const page = await fetch(flyer.link.href, { headers: { Accept: "text/html" } });
    if (!page.ok) continue;
    const html = await page.text();
    if (html.length > 3000000) continue;
    const extracted = directExtract(html, String(query || ""));
    for (const offer of extracted.offers) {
      const amount = offer.text.match(/(\d+[,.]\d{2})\s*€/);
      if (!amount) continue;
      offers.push({ ...offer, code: `${flyer.disaggregatedId}-${offer.text}`, link: flyer.link.href,
        price: Number(amount[1].replace(",", ".")) });
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
    sourceFormat: structured.length ? "structured" : flyers.length ? "pdf" : "none"
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
    if (request.method !== "POST") return json({ ok: true, service: "SpesaMeno adapters", version: 20 });
    let browser;
    try {
      const body = await request.json();
      const requested = new URL(body.url);
      if (requested.protocol !== "https:" || !allowedHost(requested.hostname)) return json({ error: "Sito non autorizzato" }, 403);
      const adapter = adapterFor(requested.hostname);
      let target = new URL(adapter?.url || requested.href);
      let directLocation = null;
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
