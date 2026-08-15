import puppeteer from "@cloudflare/puppeteer";

const ALLOWED_HOSTS = new Set([
  "italmark.it", "www.italmark.it", "esselunga.it", "www.esselunga.it", "conad.it", "www.conad.it",
  "lidl.it", "www.lidl.it", "aldi.it", "www.aldi.it", "webstore.mdspa.it", "iperal.it", "www.iperal.it",
  "latuaspesa.com", "www.latuaspesa.com", "migross.it", "www.migross.it", "carrefour.it", "www.carrefour.it",
  "coopalleanza3-0.it", "www.coopalleanza3-0.it", "eurospin.it", "www.eurospin.it", "rossettogroup.it",
  "www.rossettogroup.it", "penny.it", "www.penny.it", "famila.it", "www.famila.it", "unes.it", "www.unes.it",
  "ilgigante.net", "www.ilgigante.net", "supersigma.com", "www.supersigma.com", "d-piu.com", "www.d-piu.com",
  "bennet.com", "www.bennet.com", "metro.it", "www.metro.it"
]);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const json = (value, status = 200) => Response.json(value, { status, headers: { ...cors, "Cache-Control": "public, max-age=180, s-maxage=900" } });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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

async function acceptCookies(page) {
  await page.evaluate(() => {
    const labels = ["accetta", "accetto", "consenti", "continua senza accettare", "rifiuta"];
    for (const element of document.querySelectorAll("button,[role=button],a")) {
      const text = (element.textContent || "").trim().toLowerCase();
      if (labels.some(label => text === label || text.startsWith(label))) { element.click(); break; }
    }
  }).catch(() => undefined);
}

async function setLocation(page, cap) {
  if (!/^\d{5}$/.test(cap || "")) return false;
  const filled = await page.evaluate(postcode => {
    const target = [...document.querySelectorAll("input")].find(input => {
      const hint = `${input.placeholder || ""} ${input.name || ""} ${input.id || ""} ${input.getAttribute("aria-label") || ""}`.toLowerCase();
      return /cap|codice postale|localit|comune|indirizzo|negozio|punto vendita|store|postal|zip/.test(hint) && input.type !== "hidden";
    });
    if (!target) return false;
    target.focus(); target.value = postcode;
    target.dispatchEvent(new Event("input", { bubbles: true })); target.dispatchEvent(new Event("change", { bubbles: true }));
    const form = target.closest("form");
    const button = form?.querySelector("button[type=submit],input[type=submit]") || [...document.querySelectorAll("button,[role=button]")].find(item => /cerca|trova|conferma|applica|seleziona|continua|vai/.test((item.textContent || "").toLowerCase()));
    button?.click(); return true;
  }, cap);
  if (filled) await sleep(4500);
  return filled;
}

async function extract(page, query, networkPayloads = []) {
  const dom = await page.evaluate(needle => {
    const wanted = (needle || "").trim().toLowerCase();
    const scripts = [...document.querySelectorAll('script[type="application/ld+json"],script[type="application/json"],script[id*="data" i],script[id*="state" i]')]
      .map(script => script.textContent || "").join("\n");
    return `${document.body?.innerText || ""}\n${scripts}`;
  }, query);
  const wanted = (query || "").trim().toLowerCase();
  const raw = [dom, ...networkPayloads].join("\n").replace(/[{}\[\],]/g, "\n").replace(/\\[nrt]/g, "\n").replace(/[\"']/g, "");
  const lines = raw.split(/\n+/).map(line => line.trim()).filter(Boolean);
  if (!wanted) return { text: lines.slice(0, 2500).join("\n"), matches: 0 };
  const words = wanted.split(/\s+/).filter(word => word.length > 2);
  const stems = words.map(word => word.length > 5 ? word.slice(0, -1) : word);
  const picked = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].toLowerCase();
    if (stems.every(stem => line.includes(stem))) picked.push(...lines.slice(Math.max(0, index - 6), index + 12));
  }
  return { text: [...new Set(picked)].slice(0, 1000).join("\n"), matches: picked.length };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ ok: true, service: "SpesaMeno Browser Run", version: 2 });
    let browser;
    try {
      const body = await request.json(), target = new URL(body.url);
      if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) return json({ error: "Sito non autorizzato" }, 403);
      browser = await launchBrowser(env.BROWSER);
      const page = await browser.newPage();
      const networkPayloads = [];
      page.on("response", async response => {
        try {
          const type = (response.headers()["content-type"] || "").toLowerCase();
          const url = response.url().toLowerCase();
          if (!/(json|javascript|text\/plain|text\/html)/.test(type) && !/(api|product|promo|offer|volantin|leaflet|flyer|catalog)/.test(url)) return;
          const payload = await response.text();
          if (payload && payload.length < 1500000 && networkPayloads.join("").length < 5000000) networkPayloads.push(payload);
        } catch { /* responses without accessible bodies are ignored */ }
      });
      await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1");
      await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 1 });
      await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(3500);
      await acceptCookies(page);
      const locationApplied = await setLocation(page, String(body.cap || ""));
      await sleep(1500);
      const result = await extract(page, String(body.query || ""), networkPayloads), finalUrl = page.url();
      await browser.close(); browser = undefined;
      return json({ success: true, result: result.text, matches: result.matches, locationApplied, finalUrl });
    } catch (error) {
      if (browser) await browser.close().catch(() => undefined);
      console.error(JSON.stringify({ event: "browser_run_error", message: String(error) }));
      return json({ error: "Impossibile leggere il volantino", detail: String(error) }, 500);
    }
  }
};
