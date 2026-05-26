// Cloudflare Worker — Stripe webhook → sold.json updater
//
// SETUP (one-time):
// 1. Go to https://dash.cloudflare.com → Workers → Create Worker
//    Paste this file, then deploy.
//
// 2. Add these environment variables under Settings → Variables:
//    STRIPE_WEBHOOK_SECRET  → from Stripe Dashboard → Webhooks → your endpoint → Signing secret
//    GITHUB_TOKEN           → GitHub Personal Access Token with repo Contents write access
//
// 3. In Stripe Dashboard → Developers → Webhooks → Add endpoint:
//    URL: https://your-worker.workers.dev
//    Event: checkout.session.completed
//
// 4. For each painting's Stripe Payment Link, add metadata:
//    In Stripe Dashboard → Payment Links → Edit → Metadata
//    Key: painting_id   Value: cactus  (use the painting's id from the site)
//    Painting IDs: cactus, figure, portrait, toucan, mandalas, mermaid, jaguar, lovers, pour1, pour2

const GITHUB_REPO = "Kadrilaanes/obskura-gallery.art";
const GITHUB_FILE = "sold.json";

async function verifyStripeSignature(payload, header, secret) {
  const parts = Object.fromEntries(header.split(",").map(function(p) { return p.split("="); }));
  const signed = parts.t + "." + payload;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const hex = Array.from(new Uint8Array(sig)).map(function(b) { return b.toString(16).padStart(2, "0"); }).join("");
  return hex === parts.v1;
}

async function readSoldJson(token) {
  const r = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + GITHUB_FILE, {
    headers: { Authorization: "Bearer " + token, "User-Agent": "sold-updater" }
  });
  if (!r.ok) return { ids: [], sha: null };
  const data = await r.json();
  const parsed = JSON.parse(atob(data.content.replace(/\s/g, "")));
  return { ids: parsed.sold || [], sha: data.sha };
}

async function writeSoldJson(token, ids, sha) {
  const content = btoa(JSON.stringify({ sold: ids }, null, 2) + "\n");
  const r = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + GITHUB_FILE, {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": "sold-updater" },
    body: JSON.stringify({ message: "Mark painting as sold", content: content, sha: sha })
  });
  return r.ok;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });

    const body = await request.text();
    const sig = request.headers.get("stripe-signature") || "";

    const valid = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) return new Response("Unauthorized", { status: 401 });

    const event = JSON.parse(body);
    if (event.type !== "checkout.session.completed") return new Response("Skipped", { status: 200 });

    const paintingId = event.data.object.metadata && event.data.object.metadata.painting_id;
    if (!paintingId) return new Response("No painting_id in metadata", { status: 200 });

    const { ids, sha } = await readSoldJson(env.GITHUB_TOKEN);
    if (!ids.includes(paintingId)) {
      await writeSoldJson(env.GITHUB_TOKEN, ids.concat([paintingId]), sha);
    }

    return new Response("OK", { status: 200 });
  }
};
