/*
Copyright 2026 Adobe. All rights reserved.
Licensed under the Apache License, Version 2.0.
*/

/**
 * DOGFOOD RUN (D80), five consultants doing a week of real work in the Cookbook.
 *
 * Every call below goes to the LIVE deployment over HTTPS using each persona's OWN api key, so
 * ownership, isolation, roles and practice inheritance are all recorded exactly as they would be
 * if these five people were working from their own machines. Nothing here is seeded directly into
 * storage.
 *
 *   Jesse Pinkman   - Braze developer/marketer                      (practice: braze)
 *   Saul Goodman    - Braze marketing expert, some AEM              (practice: braze + aem)
 *   Mike Ehrmantraut- Decisioning lead, pre-sales                   (practice: decisioning, head chef)
 *   Hank Schrader   - IT/security gatekeeper                        (practice: security)
 *   Walter White    - AEM expert, HEAD CHEF + admin                 (practice: aem)
 *
 * The Jesse <-> Saul thread is deliberately a two-way collaboration: Jesse builds, Saul reviews and
 * corrects, work is handed off in both directions and the lineage is recorded.
 *
 *   node validation/dogfood.mjs [--url <mcp-server-url>] [--keep]
 *
 * --keep skips the reset (append to whatever is already there).
 * Writes: validation/dogfood-transcript.md
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const arg = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null }
const MCP_URL = arg('--url') || 'https://110557-tapmcpconnector-stage.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server'
const KEEP = process.argv.includes('--keep')

/*
 * The personas authenticate with their LOGINS, exactly as the real people do (D82 removed the
 * per-persona api keys, which were a second, weaker credential nobody could rotate). Keyed by
 * first name so the scenes below stay readable.
 */
const PEOPLE = JSON.parse(readFileSync(join(ROOT, 'demo-people.local.json'), 'utf8')).people
const LOGIN = {}
const entities = {}
for (const p of PEOPLE) {
    const first = p.id.split('.')[0]
    LOGIN[first] = `${p.id}:${p.password}`
    entities[first] = { email: p.email, roles: p.roles }
}
// The read-only account is called 'guest' but the scenes below refer to it as the viewer.
if (LOGIN.guest) { LOGIN.viewer = LOGIN.guest; entities.viewer = entities.guest }
const redact = (s) => String(s).replace(/(x-cookbook-login['":\s]*)[^"'\s,}]+/gi, '$1<redacted>')

const log = []
const notes = []
let rpcId = 0
let failures = 0

/** Call one tool as one persona. Returns the parsed payload, or throws with the tool's own error. */
async function as (persona, tool, args = {}, opts = {}) {
    let res, text
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            res = await fetch(MCP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-cookbook-login': LOGIN[persona] },
                body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } })
            })
            text = await res.text()
            break
        } catch (err) {
            // A dropped TLS read used to abandon a half-created dataset partway through a scene.
            if (attempt === 4) throw err
            await new Promise(r => setTimeout(r, 800 * attempt))
        }
    }
    let payload, isError = false
    try {
        const body = JSON.parse(text)
        const content = body?.result?.content?.[0]?.text
        isError = !!body?.result?.isError || !!body?.error
        payload = content ? tryJson(content) : (body.error?.message || text)
    } catch { payload = text }

    log.push(`### ${tool}, as **${persona}**${isError ? ' (tool error)' : ''}\n\n\`\`\`json\n${redact(JSON.stringify(args, null, 2)).slice(0, 1400)}\n\`\`\`\n\n\`\`\`\n${redact(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)).slice(0, 900)}\n\`\`\`\n`)

    if (isError && !opts.expectError) {
        failures++
        console.log(`  !! ${persona}/${tool}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`.slice(0, 200))
    }
    if (!isError && opts.expectError) {
        failures++
        console.log(`  !! ${persona}/${tool}: expected a refusal but it succeeded`)
    }
    return payload
}
const tryJson = (s) => { try { return JSON.parse(s) } catch { return s } }

/** Record a human-readable outcome line for the transcript + console. */
function note (line) { notes.push(line); console.log(`  ${line}`) }
function phase (title) { console.log(`\n=== ${title} ===`); log.push(`\n## ${title}\n`) }

/** Append a batch of steps to one recipe, returning their ids in order. */
async function steps (persona, recipeId, list) {
    const ids = []
    for (const s of list) {
        const r = await as(persona, 'append_step', { recipe_id: recipeId, source: s.source || 'ide-agent', model: s.model || 'opus-5', ...s.args, kind: s.kind, ...(s.signal ? { signal: s.signal } : {}), ...(s.content ? { content: s.content } : {}), ...(s.format ? { format: s.format } : {}), ...(s.language ? { language: s.language } : {}), ...(s.tokens ? { tokens_used: s.tokens } : {}), ...(s.tags ? { tags: s.tags } : {}) })
        if (r?.id) ids.push(r.id)
    }
    return ids
}

// ─────────────────────────────────────────────────────────────────────────────
// The work itself. Content is written as these people would actually write it.
// ─────────────────────────────────────────────────────────────────────────────

const CANVAS_LIQUID = `{% comment %}
Cacao & Co. Abandoned Cart, message 1 of 3 ("still warm")
Catalog: cacao_products. Personalises on the highest-margin item left in the cart,
NOT the most recent one: margin beats recency for a 22-SKU premium catalogue.
{% endcomment %}
{% catalog_items cacao_products {{canvas_entry_properties.\${top_margin_sku}}} %}

Subject: {{first_name | default: 'Friend'}}, your {{items[0].name}} is still in the basket

Hi {{first_name | default: 'there'}},

You left a {{items[0].name}} behind, {{items[0].cocoa_pct}}% single-origin
{{items[0].origin}}, tempered by hand in small batches.

{% if items[0].inventory_count < 25 %}
  Only {{items[0].inventory_count}} bars left in this batch.
{% elsif canvas_entry_properties.\${cart_value} >= 60 %}
  Your basket already qualifies for free chilled shipping.
{% endif %}

{% if \${most_recent_location_state} == 'AZ' or \${most_recent_location_state} == 'NV' %}
  Shipping to {{\${most_recent_location_state}}}? We add a cold pack at no charge
  between May and September, chocolate does not survive a desert doorstep.
{% endif %}

[ Finish my order ]{{canvas_entry_properties.\${cart_url}}}
`

const CANVAS_FLOW = `flowchart TD
    E["Entry: cart_abandoned<br/>(cart_value >= 25)"] --> D1{"Purchased<br/>since entry?"}
    D1 -->|yes| X1["Exit: converted"]
    D1 -->|no| W1["Delay 45 min"]
    W1 --> M1["Email 1: 'still warm'<br/>margin-ranked SKU"]
    M1 --> D2{"Opened within 20h?"}
    D2 -->|yes, no click| P1["Push: social proof<br/>'1,400 bars this month'"]
    D2 -->|no open| M2["Email 2: resend,<br/>new subject line"]
    P1 --> W2["Delay 24h"]
    M2 --> W2
    W2 --> D3{"Cart value >= 60?"}
    D3 -->|yes| M3H["Email 3: free chilled shipping<br/>NO discount (protects margin)"]
    D3 -->|no| M3L["Email 3: 10% off, 48h expiry"]
    M3H --> W3["Delay 36h (was 3 days: see steering)"]
    M3L --> W3
    W3 --> D4{"Converted?"}
    D4 -->|yes| X2["Exit: converted"]
    D4 -->|no| S["Suppress 30 days<br/>+ audience: 'cart_lapsed'"]`

const EVENT_SCHEMA = `# Cacao & Co. Braze custom event + attribute contract v1.2
# Owned by the Braze practice. Storefront team implements; we review before release.

custom_events:
  cart_abandoned:
    trigger: 30 min of cart inactivity, server-side (NOT client beacon - iOS drops it)
    properties:
      cart_value:      { type: number,  required: true,  note: "minor units, tax excluded" }
      cart_url:        { type: string,  required: true,  note: "signed, 7-day TTL" }
      item_count:      { type: number,  required: true }
      top_margin_sku:  { type: string,  required: true,  note: "computed server-side; do NOT send full cart" }
      has_perishable:  { type: boolean, required: true,  note: "gates the cold-pack copy block" }
  subscription_skipped:
    trigger: customer skips a Bar-of-the-Month shipment
    properties:
      months_active:   { type: number,  required: true }
      skip_reason:     { type: string,  required: false, note: "enum: too_much | travel | cost | other" }

custom_attributes:
  cocoa_preference:   { type: string,  note: "dark | milk | white | ruby" }
  flavour_profile:    { type: array,   note: "['fruity','nutty','floral'] - from the quiz" }
  gifting_customer:   { type: boolean, note: "ships to an address != billing more than once" }
  heat_risk_region:   { type: boolean, note: "server-derived; drives cold-pack logic + summer suppression" }

# Deliberately NOT sent to Braze:
#   - full cart contents (payload bloat, and we only ever personalise on one SKU)
#   - raw dietary/allergen flags (health-adjacent; stays in AEP under Hank's governance ruling)`

const DELIVERABILITY = `## Warm-up + throttling notes. Cacao & Co. (Braze, new IP pool)

**Situation.** Brand new dedicated IP, 240k list acquired over four years, last emailed
consistently until nine months ago. That gap is the whole problem: a list that *was* engaged
is not the same as a list that *is* engaged, and mailbox providers score on the latter.

**Plan.**
1. Weeks 1–2: 30-day openers only (~28k). Ramp 5k/day → 15k/day. Gmail first, Microsoft last,
   Outlook is the least forgiving of a cold pool.
2. Week 3: extend to 90-day openers, keep the abandoned-cart Canvas as the *only* triggered
   send. Triggered mail engages better than broadcast, so it earns reputation faster.
3. Week 4+: 180-day. Anything older than 180 days goes to a re-permission flow, not the pool.

**Throttling.** Canvas message 1 is rate-limited to 8k/hour. Not for reputation, for the
warehouse. Last Valentine's the 09:00 blast produced 1,100 orders in twenty minutes and the
pick-and-pack team lost the afternoon. Marketing pacing has to match physical capacity, which is
the kind of constraint that never appears in a martech diagram.

**Suppression (non-negotiable):**
- \`heat_risk_region = true\` AND local forecast > 30°C → suppress promotional sends. A melted bar
  costs a refund, a replacement, a support ticket and the customer.
- Corporate gifting contacts → suppress from consumer promos entirely; they buy on a PO cycle and
  a 10%-off email undermines the account manager mid-negotiation.

**What we measure.** Not open rate. Apple MPP made it a vanity number. Click-to-delivery,
conversion-per-thousand-delivered, and complaint rate per provider, on a 7-day rolling window.`

async function main () {
    console.log(`Dogfooding against ${MCP_URL}\n`)

    // ── Walter (admin/head chef) sets up the kitchen ─────────────────────────
    phase('Walter White (admin) sets up the kitchen')
    if (!KEEP) {
        await as('walter', 'admin_reset_data', { confirm: true })
        note('reset to a clean slate')
    }
    await as('walter', 'set_practices', {
        practices: [
            { id: 'braze', label: 'Braze' },
            { id: 'aem', label: 'AEM' },
            { id: 'aep', label: 'AEP / Real-Time CDP' },
            { id: 'campaign', label: 'Adobe Campaign' },
            { id: 'decisioning', label: 'Decisioning & Personalization' },
            { id: 'security', label: 'Security & IT Governance' }
        ]
    })
    const practices = await as('walter', 'list_practices')
    note(`practices configured: ${(practices.practices || []).map(p => p.id).join(', ')}`)

    for (const [persona, list] of Object.entries({
        jesse: ['braze'], saul: ['braze', 'aem'], mike: ['decisioning'], hank: ['security'], walter: ['aem']
    })) {
        await as('walter', 'set_user_practices', { owner: entities[persona].email, practices: list })
    }
    note('each consultant assigned to their practice(s) by the head chef')
    await as('walter', 'set_head_chefs', { head_chefs: [entities.walter.email, entities.mike.email] })
    note('two head chefs: Walter (AEM) and Mike (decisioning)')

    // ── Jesse: the abandoned-cart Canvas ────────────────────────────────────
    phase('Jesse Pinkman: Cacao & Co. abandoned-cart Canvas (Braze)')
    const prior = await as('jesse', 'search_resources', { query: 'abandoned cart braze canvas' })
    note(`reuse check first: ${Array.isArray(prior) ? prior.length : 0} prior result(s), greenfield, so build`)

    await as('jesse', 'start_project', { name: 'Cacao & Co.: Lifecycle Activation', note: 'Premium single-origin chocolate DTC brand. Braze build + AEM landing pages. Phase 1: cart recovery, loyalty, subscription retention.' })
    const jCart = await as('jesse', 'start_recipe', { project: 'Cacao & Co.: Lifecycle Activation', title: 'Abandoned-cart Canvas: the Tempering Series (3 messages)' })
    note(`recipe created, practice inherited: ${jCart.practice}`)

    const jCartSteps = await steps('jesse', jCart.id, [
        {
            kind: 'decision', tokens: 1450, tags: ['braze', 'canvas', 'cart-recovery'],
            content: `# Decision, rank the cart on MARGIN, not recency; 45-minute first touch

**Context.** 22 SKUs, gross margin spread from 31% (milk bars) to 68% (single-origin
limited batches). Default Braze abandoned-cart patterns personalise on the most recently
added item.

**Decision.** Personalise message 1 on the highest-margin item in the cart, computed
server-side and sent as \`top_margin_sku\`.

**Why.** Recency is a proxy for intent, but on a 22-SKU catalogue where the customer is
already in-basket, intent is established, what's left to influence is *what* they buy. A
recovered cart anchored on a 68%-margin bar is worth roughly double one anchored on a milk bar.

**First touch at 45 minutes, not the conventional 1 hour.** Chocolate is an impulse/gift
purchase with a short consideration window; the client's own analytics show 71% of recoveries
land inside 3 hours, and cart sessions here are 4m 20s median, far shorter than the apparel
benchmarks the 1-hour convention comes from. 45 minutes is late enough not to feel like
surveillance, early enough to catch the window.

**Rejected alternatives.**
- *Full cart in the payload*: bloats the event, and we only ever render one item.
- *Discount in message 1*: trains customers to abandon deliberately. Discount appears only in
  message 3, and only below the £60 free-shipping threshold.
- *SMS as the first touch*: client has no SMS consent for 84% of the list. Non-starter.`
        },
        {
            kind: 'code', language: 'liquid', format: 'liquid', tokens: 2100, tags: ['braze', 'liquid', 'catalog'],
            content: CANVAS_LIQUID
        },
        {
            kind: 'diagram', format: 'mermaid', tokens: 980, tags: ['braze', 'canvas', 'flow'],
            content: CANVAS_FLOW
        },
        {
            kind: 'config', format: 'yaml', tokens: 1620, tags: ['braze', 'event-schema', 'contract'],
            content: EVENT_SCHEMA
        },
        {
            kind: 'doc', format: 'md', tokens: 1890, tags: ['braze', 'deliverability', 'ip-warmup'],
            content: DELIVERABILITY
        },
        {
            // The dead end, captured honestly, then discarded during curation.
            kind: 'code', language: 'javascript', format: 'js', tokens: 760, tags: ['braze', 'dead-end'],
            content: `// ABANDONED APPROACH, client-side cart beacon.
// Kept only long enough to prove it doesn't work; superseded by the server-side event.
// iOS 17 Safari drops the beacon on tab close ~40% of the time, and the misses are not
// random: they skew to mobile, which is 68% of this client's traffic. A cart-recovery
// programme that silently ignores two thirds of the audience is worse than none, because
// the dashboard still looks fine.
window.addEventListener('beforeunload', () => {
  navigator.sendBeacon('/braze/cart-abandoned', JSON.stringify(cart))
})`
        }
    ])
    note(`captured ${jCartSteps.length} ingredients (decision, liquid, canvas flow, event contract, deliverability, one dead end)`)

    // Saul reviews before Jesse bakes, the correction is the valuable capture.
    await steps('jesse', jCart.id, [
        {
            kind: 'steering', signal: 'reject', tokens: 240, tags: ['review', 'saul'],
            content: `Saul rejected the 3-day wait before message 3.

His words: "Three days on a perishable gift item and you're emailing them about a Mother's Day
present on the Tuesday after. Also, if we're running a 48-hour discount expiry, a 3-day wait
means the offer in message 3 outlives the urgency we claimed in message 2, that's the kind of
inconsistency a regulator reads as misleading."

Both points stand. The second one hadn't occurred to me.`
        },
        {
            kind: 'steering', signal: 'correct', tokens: 310, tags: ['review', 'saul', 'correction'],
            content: `Corrected: final delay 3 days → 36 hours, and the discount expiry now reads
"expires Thursday 23:59" (an absolute time, resolved by Liquid) instead of "48 hours".

Rule extracted for the practice: **any countdown in copy must be resolvable to an absolute
timestamp at send time.** Relative urgency drifts as soon as a delay step changes, and nobody
re-reads the copy when they retune a Canvas timing.`
        }
    ])
    note('Saul reviewed pre-bake: 3-day wait rejected, corrected to 36h + absolute expiry')

    // Curate: approve the keepers, discard the dead end.
    await as('jesse', 'approve_steps', { step_ids: jCartSteps.slice(0, 5), note: 'Reviewed with Saul. Reusable across any perishable-goods DTC cart programme.' })
    await as('jesse', 'discard_step', { step_id: jCartSteps[5] })
    note('approved 5 ingredients, discarded the client-side beacon dead end')
    const jCartBaked = await as('jesse', 'bake_recipe', { id: jCart.id, note: 'Live in production 12 Aug. Reusable pattern: margin-ranked cart recovery for perishable goods.' })
    note(`baked: ${jCartBaked.baked === true}`)

    // ── Saul: loyalty promo terms + the AEM landing page ────────────────────
    phase('Saul Goodman. Golden Ticket loyalty promo (Braze + AEM), building on Jesse\'s work')
    const found = await as('saul', 'search_resources', { query: 'abandoned cart canvas margin' })
    note(`Saul searched first and found Jesse's baked work: ${Array.isArray(found) ? found.length : 0} hit(s), reuse, not rebuild`)
    const jesseWork = await as('saul', 'get_resource', { id: jCart.id })
    note(`Saul read Jesse's recipe end to end (${(jesseWork.steps || []).length} ingredients) before writing terms`)

    const sPromo = await as('saul', 'start_recipe', { project: 'Cacao & Co.: Lifecycle Activation', title: 'Golden Ticket loyalty promo: offer terms, eligibility and the AEM landing page', practice: 'braze' })
    const sPromoSteps = await steps('saul', sPromo.id, [
        {
            kind: 'decision', tokens: 1710, tags: ['loyalty', 'promo-mechanics', 'legal'],
            content: `# Decision, tiered "Golden Ticket" over BOGO, and why the mechanic is a legal question

**The ask.** Client wants a Willy Wonka golden-ticket mechanic: a small number of orders
contain a ticket winning "chocolate for a year."

**Decision.** Run it as a **guaranteed tiered reward with a chance-based top prize**, not a
pure prize draw:
- Every 4th order in the programme earns a guaranteed £5 credit (the retention engine).
- 1 in 2,000 orders contains a Golden Ticket, 12 months of Bar of the Month (the story).

**Why not straight BOGO.** BOGO on a 68%-margin single-origin bar hands away the entire margin
on the brand's most defensible product, and it teaches the customer that the real price is half
the sticker. Premium brands that discount their hero SKU stop being premium brands. The tiered
credit costs less per retained customer and rewards *frequency*, which is what a subscription
business actually needs.

**The part nobody enjoys but everyone needs.** A chance-based prize with no purchase-free entry
route is a **lottery** in the UK, not a prize competition, and running one without a licence is a
criminal offence, not a fine, an offence. Two ways to stay legal, and we must pick one before a
single email ships:
1. **Skill element**, entrants answer a genuine question ("which country produces the cocoa in
   our Ruby bar?"). Trivially easy is fine; it must be a real question.
2. **Free entry route**, a postal/web entry with no purchase required, given equal prominence.

**Recommendation: option 1.** A free-entry route on a DTC storefront invites bulk-entry farming,
and "equal prominence" would force ticket messaging onto the free route in every email, which
wrecks the campaign's own conversion story.

**Consequence for the build:** the ticket claim page needs a question field, answer validation,
and the answer stored with the entry for audit. Flagged to Jesse for the Braze side and taken by
me for the AEM page.`
        },
        {
            kind: 'doc', format: 'md', tokens: 2240, tags: ['legal', 'terms', 'promo'],
            content: `# Golden Ticket, promotional terms (draft 3, for client legal review)

**Promoter:** Cacao & Co. Ltd, registered in England & Wales.
**Promotion period:** 1 Sep 2026 00:00 BST – 30 Nov 2026 23:59 GMT. *(Note the BST→GMT change
inside the window, the clocks go back on 25 Oct. Every deadline in every email must render as an
absolute local time, per the rule Jesse and I extracted from the cart Canvas review.)*

**1. Eligibility.** UK mainland residents aged 18+. Excludes employees of the Promoter, its
agencies, and their immediate families. *(Us. We are the agency. Nobody wins the chocolate.)*

**2. How to enter.** Each qualifying order (£25+ excluding shipping) placed in the promotion
period includes one entry. Entrants must correctly answer the skill question shown at checkout.
No purchase-free entry route is offered; entry requires the skill element under §3.

**3. Skill element.** "Which country of origin is named on our Ruby 47% bar?" The answer appears
on the product page and on the bar's wrapper. It is a real question with a real answer, which is
what makes this a prize competition and not a lottery.

**4. Prizes.**
- *Guaranteed:* £5 account credit on every 4th qualifying order. Credit expires 6 months from
  issue. Not exchangeable for cash.
- *Chance:* 1 in 2,000 qualifying orders receives a Golden Ticket, 12 consecutive monthly
  deliveries of Bar of the Month (RRP £14/month, total value £168). Ticket must be claimed within
  30 days of the order date.

**5. Odds and honesty.** The 1-in-2,000 rate is fixed for the promotion period and will not be
adjusted mid-flight. If ticket volume runs ahead of forecast, the Promoter honours every ticket
issued and closes the chance element early with a public notice, the Promoter does **not** quietly
reduce the rate. *(Insisted on. Silently degrading published odds is the single fastest way to turn
a marketing promotion into an ASA ruling and a screenshot on social media.)*

**6. Substitution.** Where a Bar of the Month is unavailable due to harvest or supply, a bar of
equal or greater value is substituted. Cocoa is an agricultural product; the terms have to admit
that.

**7. Allergens.** Products are manufactured in a facility handling milk, soy and tree nuts.
Winners with allergies should contact us before their first delivery. **Allergen data is not
collected through this promotion**, per the security practice's governance ruling, health-adjacent
data does not enter the marketing stack.

**8. Data.** Entry data is processed to administer the promotion (lawful basis: contract) and
retained 12 months after the promotion closes for audit, then deleted. Marketing consent is
separate, unbundled, and never a condition of entry.

**Open items for client legal:** (a) confirm the Promoter entity name exactly as registered;
(b) confirm the £5 credit is issued as store credit and not a cash equivalent for accounting;
(c) sign off the skill question wording.`
        },
        {
            kind: 'code', language: 'json', format: 'json', tokens: 1340, tags: ['aem', 'content-fragment', 'model'],
            content: `{
  "_comment": "AEM Content Fragment Model, golden-ticket-promo. Authors edit the promo, never the code.",
  "modelPath": "/conf/cacao/settings/dam/cfm/models/golden-ticket-promo",
  "fields": [
    { "name": "headline",        "type": "text",        "required": true,  "maxLength": 60,
      "hint": "60 chars, the AEM page shares this headline with the Braze subject line" },
    { "name": "bodyCopy",        "type": "multitext",   "required": true,  "format": "richtext" },
    { "name": "skillQuestion",   "type": "text",        "required": true,
      "hint": "MANDATORY. The promotion is a prize competition ONLY because this exists. Do not remove." },
    { "name": "skillAnswers",    "type": "text",        "multi": true,     "required": true,
      "hint": "Accepted answers, case-insensitive. Include common misspellings, a genuine entrant who spells Madagascar wrong still answered correctly." },
    { "name": "termsFragment",   "type": "fragmentref", "required": true,
      "hint": "References the terms CF so terms live in ONE place across page, email and checkout" },
    { "name": "promoStart",      "type": "date",        "required": true },
    { "name": "promoEnd",        "type": "date",        "required": true,
      "hint": "Stored with timezone. Renders as absolute local time everywhere." },
    { "name": "oddsStatement",   "type": "text",        "required": true,
      "hint": "Published odds. Changing this mid-promotion is a compliance event, not a content edit." },
    { "name": "heroImage",       "type": "contentref",  "required": true },
    { "name": "prizeValueGBP",   "type": "number",      "required": true }
  ]
}`
        },
        {
            kind: 'code', language: 'html', format: 'htl', tokens: 1120, tags: ['aem', 'htl', 'accessibility'],
            content: `<!--/* golden-ticket-claim.html. AEM component for the claim form.
     Server-rendered: the skill answer must never be validatable client-side, or the
     "skill" element is decorative and the legal basis evaporates. */-->
<sly data-sly-use.promo="com.cacao.core.models.GoldenTicketPromo"/>
<section class="gt-claim" data-sly-test="\${promo.active}">
    <h1 class="gt-claim__headline">\${promo.headline}</h1>
    <div class="gt-claim__body">\${promo.bodyCopy @ context='html'}</div>

    <form method="post" action="\${promo.claimEndpoint}" class="gt-claim__form">
        <input type="hidden" name=":cq_csrf_token" value="\${promo.csrfToken}"/>
        <label for="gt-answer">\${promo.skillQuestion}</label>
        <input id="gt-answer" name="answer" type="text" required
               autocomplete="off" aria-describedby="gt-answer-help"/>
        <p id="gt-answer-help" class="gt-claim__help">
            You'll find the answer on the bar's wrapper, or on the product page.
        </p>
        <button type="submit">Claim my ticket</button>
    </form>

    <p class="gt-claim__odds">\${promo.oddsStatement}</p>
    <details class="gt-claim__terms">
        <summary>Full terms and conditions</summary>
        <sly data-sly-resource="\${promo.termsPath @ resourceType='cacao/components/content/fragment'}"/>
    </details>
</section>
<div data-sly-test="\${!promo.active}" class="gt-claim__closed">
    <p>This promotion has closed. Every ticket issued will be honoured.</p>
</div>`
        },
        {
            kind: 'message', tokens: 420, tags: ['client-comms'],
            content: `Note for the client call: the skill question is not a nice-to-have we can drop
if it hurts conversion. Without it this is an unlicensed lottery. If conversion on the claim form
comes in low, the levers are the *question's* difficulty and the form's placement, not its
existence. I'd rather explain that once now than unpick it after launch.`
        }
    ])
    await as('saul', 'approve_steps', { step_ids: sPromoSteps, note: 'Terms drafted, model and claim component reviewed. Reusable for any prize-competition mechanic in the UK.' })
    await as('saul', 'bake_recipe', { id: sPromo.id, note: 'Pending client legal sign-off on three open items, but the mechanic and the compliance reasoning are reusable now.' })
    note(`Saul baked the loyalty promo recipe (${sPromoSteps.length} ingredients approved)`)

    // Saul hands the Braze build back to Jesse, as a first-class handoff with lineage.
    const handoff = await as('saul', 'save_resource', {
        type: 'handoff-prompt',
        title: 'Handoff to Jesse: build the Golden Ticket Braze side (ticket issuance + claim reminders)',
        project: 'Cacao & Co.: Lifecycle Activation',
        content: `Jesse, the promo mechanic and terms are baked (see the Golden Ticket recipe). Braze side is yours.

WHAT YOU NEED TO BUILD
1. Ticket issuance is NOT a Braze decision. The storefront decides (1-in-2,000, server-side,
   audited) and fires \`golden_ticket_issued\` with { ticket_id, order_id, expires_at }. Braze
   messages the outcome, it never rolls the dice, if Braze picked winners we could not audit it,
   and an unauditable prize competition is the thing we are specifically avoiding.
2. Claim reminder Canvas: entry on \`golden_ticket_issued\`, exit on \`golden_ticket_claimed\`.
   Touchpoints at +1h (congratulations), +7d, +21d, +29d (last call). Hard exit at expires_at.
3. Every deadline renders as an absolute local time. The promotion crosses the BST→GMT change on
   25 Oct, a relative "30 days" string will be an hour wrong for part of the window, which is
   exactly the kind of detail that ends up in a complaint.
4. The £5 guaranteed credit on every 4th order: needs \`qualifying_order_count\` as a custom
   attribute, incremented server-side. Do not compute it in Braze from event history, event
   retention is 90 days and the promotion runs 91.

WHAT NOT TO DO
- Do not send ticket messaging to \`heat_risk_region\` suppressions. A winner who can't receive
  chocolate for four months is a support ticket, not a win.
- Do not bundle marketing consent into the claim flow. Terms §8, and it's unbundled for a reason.

I'm around Thursday for the client legal call if you want the compliance context first-hand.`
    })
    await as('saul', 'set_task_status', { id: handoff.id, status: 'open' })
    note('Saul logged a handoff-prompt to Jesse (ticket issuance stays server-side and auditable)')

    // ── Jesse takes the handoff, collaboration in the other direction ──────
    phase('Jesse Pinkman, takes Saul\'s handoff, builds the ticket flow')
    await as('jesse', 'set_task_status', { id: handoff.id, status: 'in_progress' })
    const jTicket = await as('jesse', 'start_recipe', { project: 'Cacao & Co.: Lifecycle Activation', title: 'Golden Ticket: issuance contract + claim-reminder Canvas' })
    const jTicketSteps = await steps('jesse', jTicket.id, [
        {
            kind: 'steering', signal: 'affirm', tokens: 260, tags: ['handoff', 'saul'],
            content: `Took Saul's constraint that Braze must not pick winners. He's right and it's not
only a legal point, it's an architecture point I'd have got wrong. My instinct was a Canvas
random-split at 0.05%, which is one line of config and completely unauditable: no record of the
draw, no way to prove the published odds were honoured, and the split silently re-rolls if anyone
edits the Canvas. Issuance moves to the storefront with a persisted audit row.`
        },
        {
            kind: 'config', format: 'json', tokens: 1480, tags: ['braze', 'canvas', 'contract'],
            content: `{
  "canvas": "Golden Ticket. Claim Reminders",
  "entry": { "event": "golden_ticket_issued", "reeligibility": "never" },
  "exit_criteria": [
    { "event": "golden_ticket_claimed" },
    { "attribute": "email_unsubscribed", "equals": true },
    { "absolute": "{{event_properties.\${expires_at}}}", "note": "hard exit, per-entrant" }
  ],
  "steps": [
    { "at": "+1h",  "channel": "email", "name": "You found a Golden Ticket",
      "note": "Not immediate. A 'you won' email landing in the same second as the order confirmation reads like a bug or a phish." },
    { "at": "+7d",  "channel": "email", "name": "Your ticket is waiting", "skip_if": "claimed" },
    { "at": "+21d", "channel": "push",  "name": "Two weeks left", "skip_if": "claimed or no_push_token" },
    { "at": "+29d", "channel": "email", "name": "Last call, expires {{expires_at | absolute_local}}", "skip_if": "claimed" }
  ],
  "suppressions": ["heat_risk_region_summer", "corporate_gifting"],
  "liquid_rules": {
    "no_relative_deadlines": "Every deadline renders via absolute_local. The promotion crosses the BST/GMT boundary on 25 Oct.",
    "fallbacks": "first_name defaults to 'Friend'. A prize email opening with 'Hi ,' is worse than not personalising."
  },
  "qualifying_order_count": {
    "source": "server-side custom attribute, incremented on order settlement",
    "why_not_braze": "Braze event retention is 90 days; the promotion runs 91. Computing the 4th-order credit from event history would silently stop crediting loyal customers in the final week - the exact customers the mechanic exists to reward."
  }
}`
        },
        {
            kind: 'code', language: 'liquid', format: 'liquid', tokens: 890, tags: ['braze', 'liquid'],
            content: `{% comment %} Golden Ticket, winner email, +1h. Absolute deadline, always. {% endcomment %}
{% assign expiry = event_properties.\${expires_at} | date: "%A %-d %B at %H:%M %Z" %}

Subject: {{first_name | default: 'Friend'}}, there's a Golden Ticket in your order

You found one.

Order {{event_properties.\${order_id}}} contains one of the Golden Tickets we hid across the
autumn batches. It's worth twelve months of Bar of the Month, a different single-origin bar
posted to you every month, chosen by the people who temper them.

Claim it by **{{expiry}}**. After that the ticket returns to the batch.

[ Claim my twelve months ]{{event_properties.\${claim_url}}}

{% comment %} Ticket 1-in-2000. Odds fixed for the promotion period and honoured in full. {% endcomment %}`
        },
        {
            kind: 'doc', format: 'md', tokens: 760, tags: ['qa', 'launch-checklist'],
            content: `## Launch checklist. Golden Ticket Braze side

- [x] Entry event fires from storefront with ticket_id, order_id, expires_at
- [x] Hard exit on expires_at verified per-entrant (not a global date)
- [x] \`absolute_local\` filter renders correctly either side of 25 Oct, tested both
- [x] Suppression lists applied: heat_risk_region_summer, corporate_gifting
- [x] first_name fallback on all four touchpoints
- [ ] Storefront audit table live (blocked on client engineering, ETA Friday)
- [ ] Client legal sign-off on the skill question wording (Saul chasing)

**Tested the unhappy paths**, because those are the ones that make the news:
- ticket issued → customer unsubscribes → no further messaging. Pass.
- ticket issued → claimed within the hour → +1h email suppressed correctly. Pass.
- ticket issued → order refunded → **currently still messages the customer.** Open defect, raised
  with client engineering: needs a \`golden_ticket_voided\` event. Congratulating someone on a prize
  attached to a cancelled order is a bad enough experience that I'd hold launch for it.`
        }
    ])
    await as('jesse', 'approve_steps', { step_ids: jTicketSteps, note: 'Built on Saul\'s handoff. The issuance-stays-server-side reasoning is the reusable part.' })
    await as('jesse', 'bake_recipe', { id: jTicket.id, note: 'One open defect logged (refund → void). Pattern reusable for any auditable prize mechanic.' })
    await as('saul', 'link_recipes', { handoff_id: handoff.id, recipe_ids: [jTicket.id] })
    await as('saul', 'set_task_status', { id: handoff.id, status: 'done' })
    note('Jesse baked the ticket flow; Saul linked the handoff to it and closed the task, full lineage recorded')

    // ── Mike: decisioning architecture + pre-sales ──────────────────────────
    phase('Mike Ehrmantraut: decisioning architecture and a client proposal')
    await as('mike', 'start_project', { name: 'Gustavo\'s Fine Foods. Offer Decisioning', note: 'Multi-brand food group. Central decisioning across email, app and in-store POS. Pre-sales through to architecture.' })
    const mArch = await as('mike', 'start_recipe', { project: 'Gustavo\'s Fine Foods. Offer Decisioning', title: 'Decisioning architecture: eligibility, ranking, capping and the arbitration contract' })
    note(`Mike's recipe inherited practice: ${mArch.practice}`)
    const mArchSteps = await steps('mike', mArch.id, [
        {
            kind: 'diagram', format: 'mermaid', tokens: 1240, tags: ['decisioning', 'architecture'],
            content: `flowchart LR
    subgraph SRC["Signals"]
        P["Profile<br/>(CDP)"]
        C["Consent<br/>(preference centre)"]
        I["Inventory<br/>(per-store, 15 min)"]
        H["Interaction history<br/>(90d)"]
    end
    subgraph DEC["Decision service"]
        E["1. Eligibility<br/>HARD filters"]
        R["2. Ranking<br/>score = value x propensity x freshness"]
        CAP["3. Capping<br/>per-channel + global fatigue"]
        A["4. Arbitration<br/>one winner per placement"]
    end
    subgraph CH["Placements"]
        EM["Email block"]
        AP["App home tile"]
        POS["POS receipt coupon"]
    end
    P --> E
    C --> E
    I --> E
    H --> R
    E --> R --> CAP --> A
    A --> EM
    A --> AP
    A --> POS
    A -.->|"decision + reason<br/>logged with inputs"| L[("Decision log<br/>(replayable)")]`
        },
        {
            kind: 'decision', tokens: 2060, tags: ['decisioning', 'ranking', 'architecture'],
            content: `# Decision, eligibility is a hard filter, ranking is a score, and never mix the two

**The mistake I see on every one of these engagements.** Teams express eligibility as a heavy
negative weight in the ranking model ("expired offers score -1000") instead of as a filter. Then
one day the arithmetic goes the other way, a big enough positive on another factor, or a bug in
a weight, and an ineligible offer wins. Now you've sent an alcohol promotion to someone who
opted out of it, or an in-store coupon for a product that store doesn't stock.

**Decision.** Two strictly separate stages, in this order:

**1. Eligibility, boolean, no scores, no exceptions.**
- consent for the category (opt-out is absolute, never a weight)
- age-gated products vs verified age
- offer window: now between valid_from and valid_to
- inventory: for a redeemable in-store offer, the item is in stock at *that* store
- exclusions: no competing offer already redeemed this cycle

**2. Ranking, score the survivors.**
\`score = margin_value x propensity x freshness_decay x strategic_boost\`
- \`margin_value\`, contribution, not revenue. Ranking on revenue systematically promotes the
  cheapest thing that sells.
- \`propensity\`, model output, clamped to [0.05, 0.95]. Never 0 or 1: a hard 0 means an offer can
  never be shown, so it can never gather data, so its propensity stays 0. That's a model that
  quietly freezes its own opinions.
- \`freshness_decay\`, 0.85^(times_seen). Cheap, explainable, and good enough. A learned fatigue
  model was proposed; it is not worth the operational cost at this client's volume.
- \`strategic_boost\`, a documented, time-boxed override for commercial priorities (a supplier
  campaign, a surplus harvest). **Must expire.** Every permanent boost is a business rule wearing
  a model's clothes, and in twelve months nobody remembers why the number is 1.4.

**3. Capping.** Per-channel (email 3/week, push 2/week, POS 1/transaction) plus a global fatigue
cap across all channels. Capping after ranking, so the customer gets their best eligible offer
rather than whichever one arrived first.

**4. Arbitration.** One winner per placement, ties broken by margin then by offer id (a
deterministic tiebreak matters, a random one makes bug reports unreproducible).

**Every decision is logged with its inputs and the reason the winner won.** Non-negotiable. When a
client asks "why did my customer see that?", the answer must be a replay, not a theory. This is
also what makes the whole thing defensible if a regulator asks.`
        },
        {
            kind: 'config', format: 'yaml', tokens: 1390, tags: ['decisioning', 'offer-constraints'],
            content: `# Gustavo's Fine Foods, offer constraint catalogue (excerpt)
# Reviewed with the client's trading team. Eligibility is boolean; ranking never overrides it.

offers:
  - id: gff_wine_case_20
    name: "20% off any mixed wine case"
    category: alcohol
    eligibility:
      consent_category: alcohol_marketing     # opt-out is absolute
      min_age_verified: 18
      channels: [email, app]                  # NOT pos - no age verification at self-checkout
      requires_stock: false                   # online fulfilment
    ranking:
      margin_value_gbp: 8.40
      strategic_boost: { value: 1.25, expires: '2026-10-31', reason: 'Supplier co-fund, Q4 only' }

  - id: gff_cheese_counter_bogo
    name: "Cheese counter - buy 2 get 1"
    category: fresh_food
    eligibility:
      consent_category: general_marketing
      channels: [pos, app]
      requires_stock: true                    # per-store; a coupon for an empty counter is worse than no coupon
      store_has_counter: true                 # 31 of 88 stores have a staffed counter
    ranking:
      margin_value_gbp: 3.10
      strategic_boost: null

  - id: gff_surplus_harvest_tomato
    name: "Surplus harvest - 3kg tomatoes, half price"
    category: fresh_food
    eligibility:
      consent_category: general_marketing
      channels: [email, app, pos]
      requires_stock: true
      valid_to: '2026-08-22'                  # perishable: the offer window IS the shelf life
    ranking:
      margin_value_gbp: 0.90
      strategic_boost: { value: 3.00, expires: '2026-08-22', reason: 'Waste avoidance beats margin - unsold surplus is a 100% loss plus disposal cost' }

global_caps:
  email: { per_week: 3 }
  push:  { per_week: 2 }
  pos:   { per_transaction: 1 }
  fatigue: { any_channel_per_day: 2, note: 'Counted across channels. Three channels each obeying their own cap is still six messages.' }`
        },
        {
            kind: 'message', tokens: 380, tags: ['client-comms', 'decisioning'],
            content: `Pushed back on the client's request for a "learning system that figures out the
rules itself." What they actually need first is a system whose decisions they can explain to their
own trading team. Explainability is the prerequisite for trust, and trust is the prerequisite for
being allowed to automate anything at all. We can add learned components once the deterministic
spine is in place and logged, and by then we'll have the labelled decision log needed to train
them properly. Doing it the other way round is how these programmes get switched off in month
four.`
        }
    ])
    await as('mike', 'approve_steps', { step_ids: mArchSteps, note: 'Architecture reviewed with the client trading team. The eligibility/ranking separation is the reusable core.' })
    await as('mike', 'bake_recipe', { id: mArch.id, note: 'Reference architecture for any multi-channel offer decisioning engagement.' })
    note('Mike baked the decisioning reference architecture')

    const mProposal = await as('mike', 'start_recipe', { project: 'Gustavo\'s Fine Foods. Offer Decisioning', title: 'Pre-sales: personalisation roadmap proposal and commercial model' })
    const mPropSteps = await steps('mike', mProposal.id, [
        {
            kind: 'doc', format: 'md', tokens: 2680, tags: ['pre-sales', 'proposal', 'commercial'],
            content: `# Proposal. Gustavo's Fine Foods personalisation roadmap (exec summary + phasing)

## The one-page version

Gustavo's runs 88 stores, an app with 340k monthly actives, and an email programme that sends the
same offer to everyone. The opportunity is not "add AI", it's that **every channel currently
decides independently**, so a customer can receive three uncoordinated offers in a day and the
best one is chosen by whichever system happened to run first.

We propose a central decision service that all three channels call, delivered in three phases over
five months, with a measurable outcome at the end of each. **No phase depends on the client
replatforming anything.**

## Phasing

**Phase 1. Decision spine (8 weeks).** Central eligibility + ranking + capping, live on email
only. Deterministic and fully logged.
*Outcome:* one place where offer rules live; every send explainable. *Success measure:* offer
click-through vs the current broadcast baseline, plus zero consent breaches in audit.

**Phase 2. Multi-channel arbitration (6 weeks).** App home tile and POS receipt join the same
service. Global fatigue capping across channels.
*Outcome:* a customer stops receiving three uncoordinated offers a day. *Success measure:* offers
per customer per week down, redemption per customer up. Both, together, either alone is gameable.

**Phase 3. Propensity + surplus routing (6 weeks).** Add the propensity model to ranking, and
route surplus/perishable stock into the offer pool automatically.
*Outcome:* margin-aware personalisation, and waste avoidance as a marketing channel. *Success
measure:* incremental margin per customer, and surplus sell-through before expiry.

## Commercial model

| Phase | Duration | Team | Fees (GBP) |
|---|---|---|---|
| 1. Decision spine | 8 wks | Architect 0.5, Eng 1.5, Consultant 0.5 | 168,000 |
| 2. Multi-channel | 6 wks | Architect 0.3, Eng 1.5, Consultant 0.5 | 121,000 |
| 3. Propensity + surplus | 6 wks | Architect 0.3, Eng 1.0, Data Sci 1.0 | 134,000 |
| **Total** | **20 wks** | | **423,000** |

Fixed-price per phase, with a go/no-go decision gate at the end of each. The client can stop after
Phase 1 with a working, valuable system, that is deliberate. A roadmap that only pays off if you
buy all of it is a roadmap designed for the vendor.

Excluded: licence costs, the client's own engineering effort on the storefront event contract
(estimated 15 days, they have the team), and any data-quality remediation in the CDP, which we
will assess in week 1 and quote separately if needed, because guessing at it now would either pad
the price or set up a change request.

## Risks stated up front

1. **Per-store inventory freshness.** Phase 2's in-store offers are only as good as the 15-minute
   inventory feed. If that feed is unreliable, redeemable coupons for out-of-stock items will
   damage trust faster than personalisation builds it. We assess this in week 1 and will
   recommend deferring POS rather than shipping it on a bad feed.
2. **Consent data fragmentation.** Three systems currently hold marketing preferences. If they
   disagree, the decision service must take the most restrictive, and someone at Gustavo's has to
   own that reconciliation. We can advise; we cannot own their consent record.
3. **Organisational.** Central decisioning moves control away from individual channel owners.
   That is the point, and it is also the thing most likely to stall the programme. We recommend a
   named executive sponsor before Phase 2.`
        },
        {
            kind: 'decision', tokens: 1120, tags: ['pre-sales', 'scoping'],
            content: `# Decision, quote three phases with stop points, not a 20-week programme

The client asked for a single price for "the whole personalisation transformation."

**Declined, and told them why.** A single 20-week fixed price forces us to price in every unknown,
which makes the number big enough to need board approval, which turns a five-month project into a
nine-month procurement. Worse, it means the first genuinely valuable thing they get is in month
five.

**What we quoted instead:** three phases, each independently valuable, each with a stop point.
Phase 1 alone leaves them better off than they are now.

**The commercial reality:** we probably book less revenue this way if the client stops after Phase
2. We also dramatically increase the odds of the programme starting at all, and of a reference we
can name. Given the pipeline in this sector is entirely referral-driven, a finished Phase 2 is
worth more than a stalled Phase 3.

**Deliberately excluded from scope:** CDP data-quality remediation. We will not quote work whose
size we cannot see. Assessed in week 1, quoted separately if needed. Padding it now would be
dishonest; absorbing it silently would blow the fixed price.`
        },
        {
            kind: 'steering', signal: 'correct', tokens: 290, tags: ['review', 'internal'],
            content: `Corrected my own first draft: it led with the architecture diagram and put the
business outcome on page four. Nobody in a pre-sales meeting reads to page four. Restructured so
the one-page version states the actual problem, three channels deciding independently, in the
first paragraph, and the architecture became an appendix. The technical content didn't change at
all; the order did, and the order is what determines whether it gets read.`
        }
    ])
    await as('mike', 'approve_steps', { step_ids: mPropSteps, note: 'Proposal sent 11 Aug. Phasing structure and the stop-point argument are reusable across pre-sales.' })
    await as('mike', 'bake_recipe', { id: mProposal.id, note: 'Reusable pre-sales pattern: phase with stop points, exclude what you cannot size.' })
    note('Mike baked the pre-sales proposal recipe')

    // ── Hank: security awareness programme ──────────────────────────────────
    phase('Hank Schrader: phishing-simulation programme and security analytics')
    await as('hank', 'start_project', { name: 'Internal: Security Awareness Programme', note: 'Authorised internal phishing simulation and security analytics reporting. Approved by the exec team; scope is our own employees only.' })
    const hSim = await as('hank', 'start_recipe', { project: 'Internal: Security Awareness Programme', title: 'Phishing simulation template library: design, ethics guardrails and difficulty tiers' })
    note(`Hank's recipe inherited practice: ${hSim.practice}`)
    const hSimSteps = await steps('hank', hSim.id, [
        {
            kind: 'doc', format: 'md', tokens: 2410, tags: ['security', 'awareness', 'governance'],
            content: `# Phishing simulation programme, design and guardrails

**Authorisation.** Exec-approved, documented, scope limited to our own employees on
company-managed accounts. Staff are told in onboarding that simulations happen; they are not told
when. That combination is what makes this training rather than entrapment.

## Guardrails: these are the programme, not paperwork

1. **No real credential capture, ever.** Landing pages have no password field. A submitted
   simulation form records only "this user submitted", never a keystroke of what they typed.
   Collecting real passwords to prove people type real passwords would make me the largest single
   credential-theft risk in the company.
2. **No emotionally abusive pretexts.** Banned outright: fake redundancy notices, fake bonus or
   payroll-error notices, fake bereavement or family-emergency themes, fake HR disciplinary
   letters. These get high click rates precisely because they cause real distress. A programme
   that traumatises staff to produce a better metric has inverted its own purpose.
3. **No impersonation of named individuals.** Generic roles only ("IT Service Desk"), never a real
   colleague's name and never the CEO. Impersonating a named person damages trust between real
   people, and that trust is the actual control we depend on.
4. **No branded impersonation of third parties we don't control.** Simulated senders use
   look-alike internal domains we own, not spoofed Microsoft or DHL branding. (Trademark exposure,
   and it teaches the wrong lesson, "distrust that logo" instead of "check that domain".)
5. **Failure is never punitive.** Clicking routes to a 90-second explainer, not to a manager.
   The moment a simulation feeds a performance review, reporting stops, and *reporting* is the
   behaviour we're actually trying to build. A high click rate with high reporting beats a low
   click rate with silence.
6. **Reporters are thanked, every time.** Automated acknowledgement within the hour, including for
   false positives. Someone who reports a real internal newsletter has done exactly the right
   thing and must never be made to feel foolish for it.

## Difficulty tiers

**Tier 1. Obvious.** External sender, generic greeting, mismatched domain, mild urgency.
Baseline measurement. Expect 8–14% click.

**Tier 2. Plausible.** Correct internal branding, references a real business process
(expenses, room booking, a document share), sender domain off by one character. Expect 18–25%.
*This tier is where the training value is.*

**Tier 3. Targeted.** Contextual pretext tied to a genuine business rhythm, a shared-document
notification during audit season, a courier notice during a known office move. Restricted to
volunteer cohorts and staff who have completed Tier 2 training, run at most twice a year.
Expect 30–45% click, and that is not a failure of the staff.

**Tier 3 is where honesty about limits matters.** A sufficiently targeted simulation will catch
almost anyone, including me. Its purpose is not to establish that people are gullible; it is to
justify *technical* controls, because the correct conclusion from a successful Tier 3 is "awareness
training has a ceiling, invest in phishing-resistant MFA and better mail authentication," not
"train harder."

## Cadence
Monthly, rotating themes, no more than one per person per month. Every campaign preceded by a
service-desk heads-up (so they aren't blindsided by the call volume) and followed by an all-staff
summary of results with **no individual named**.`
        },
        {
            kind: 'code', language: 'html', format: 'html', tokens: 1180, tags: ['security', 'template', 'simulation'],
            content: `<!-- Simulation template T2-04 "Expense report returned". Tier 2, plausible.
     Sender: no-reply@finance-notices.<our-owned-lookalike-domain>
     Deliberate detection cues, in the order we want staff to notice them:
       1. Sender domain is not our primary domain          <- the cue we're teaching
       2. Greeting is role-generic, not the person's name
       3. Link text and href disagree
       4. Urgency without a specific consequence
     NO password field. NO credential capture. Submitting only records that a submit happened. -->
<table role="presentation" width="100%" style="font-family:Segoe UI,Arial,sans-serif">
  <tr><td style="padding:24px 0"><img src="{{sim_logo}}" alt="Finance" height="28"></td></tr>
  <tr><td>
    <p>Dear Colleague,</p>
    <p>Your expense claim <strong>EXP-{{sim_ref}}</strong> has been returned by Finance and
       requires attention before the month-end cut-off.</p>
    <p>Please review the itemisation and resubmit:</p>
    <p><a href="{{sim_tracking_url}}"
          style="background:#1a5fb4;color:#fff;padding:10px 18px;text-decoration:none;border-radius:4px">
       Review claim in Expenses Portal</a></p>
    <p style="font-size:12px;color:#666">This claim will be closed if not resubmitted.</p>
    <p style="font-size:12px;color:#666">Finance Shared Services</p>
  </td></tr>
</table>
<!-- Landing page = training explainer only. It highlights the four cues above on the email
     the user just clicked, then offers a 90-second walkthrough. No form. No shaming copy.
     Copy reviewed to be neutral: "here's what to look for", never "you failed". -->`
        },
        {
            kind: 'diagram', format: 'svg', tokens: 1340, tags: ['security', 'architecture'],
            content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 300" role="img" aria-label="Phishing simulation platform architecture">
  <style>
    .box { fill: var(--surface, #f4f4f5); stroke: var(--border, #b0b0b8); stroke-width: 1.5; rx: 6; }
    .lbl { font: 12px Segoe UI, Arial, sans-serif; fill: var(--text, #1a1a1a); }
    .hd  { font: bold 13px Segoe UI, Arial, sans-serif; fill: var(--text, #1a1a1a); }
    .arw { stroke: var(--border, #6a6a72); stroke-width: 1.5; fill: none; marker-end: url(#a); }
    .note { font: italic 11px Segoe UI, Arial, sans-serif; fill: var(--muted, #6a6a72); }
  </style>
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
    <path d="M0,0 L10,5 L0,10 z" fill="var(--border, #6a6a72)"/></marker></defs>

  <rect class="box" x="20" y="40" width="130" height="60"/>
  <text class="hd" x="34" y="64">Campaign</text><text class="lbl" x="34" y="82">scheduler</text>

  <rect class="box" x="200" y="40" width="140" height="60"/>
  <text class="hd" x="214" y="64">Template</text><text class="lbl" x="214" y="82">library (tiered)</text>

  <rect class="box" x="390" y="40" width="140" height="60"/>
  <text class="hd" x="404" y="64">Send via</text><text class="lbl" x="404" y="82">owned lookalike dom.</text>

  <rect class="box" x="580" y="40" width="120" height="60"/>
  <text class="hd" x="594" y="64">Employee</text><text class="lbl" x="594" y="82">mailbox</text>

  <rect class="box" x="390" y="160" width="140" height="60"/>
  <text class="hd" x="404" y="184">Training page</text><text class="lbl" x="404" y="202">NO form, NO creds</text>

  <rect class="box" x="200" y="160" width="140" height="60"/>
  <text class="hd" x="214" y="184">Event store</text><text class="lbl" x="214" y="202">clicked / reported</text>

  <rect class="box" x="20" y="160" width="130" height="60"/>
  <text class="hd" x="34" y="184">Analytics</text><text class="lbl" x="34" y="202">aggregate only</text>

  <path class="arw" d="M150,70 L200,70"/>
  <path class="arw" d="M340,70 L390,70"/>
  <path class="arw" d="M530,70 L580,70"/>
  <path class="arw" d="M640,100 L640,190 L530,190"/>
  <path class="arw" d="M390,190 L340,190"/>
  <path class="arw" d="M200,190 L150,190"/>
  <text class="note" x="200" y="256">Aggregates only. No per-person record leaves the event store;</text>
  <text class="note" x="200" y="272">reporting is by department, never by name.</text>
</svg>`
        },
        {
            kind: 'config', format: 'yaml', tokens: 890, tags: ['security', 'analytics', 'privacy'],
            content: `# Simulation analytics schema. Privacy-by-design: aggregates leave, individuals don't.
events:
  simulation_delivered: { fields: [campaign_id, tier, department, delivered_at] }
  simulation_opened:    { fields: [campaign_id, tier, department, opened_at]
                          note: "Open tracking is unreliable and we do NOT report on it. Kept for QA of delivery only." }
  simulation_clicked:   { fields: [campaign_id, tier, department, clicked_at, seconds_from_delivery] }
  simulation_reported:  { fields: [campaign_id, tier, department, reported_at, seconds_from_delivery]
                          note: "THE metric that matters. Time-to-report is our real detection capability." }
  simulation_submitted: { fields: [campaign_id, tier, department]
                          note: "Records THAT a form was submitted. Never what was typed. There is no field for it by design." }

retention:
  individual_level: 30 days   # long enough to route training, short enough not to become a record about a person
  aggregate_level: 3 years    # trend reporting

reporting_rules:
  - "No individual is named in any report, to any audience, including their manager."
  - "Departments with fewer than 8 staff roll up to their parent - otherwise 'department' identifies a person."
  - "Report time-to-report alongside click rate. Click rate alone rewards silence."
  - "Repeat-clicker cohorts are addressed with training, never with escalation."`
        },
        {
            kind: 'steering', signal: 'reject', tokens: 340, tags: ['governance', 'ethics'],
            content: `Rejected a request from a department head for a simulated "bonus payment
confirmation" template targeted at their own team.

Reasoning given to them: it would work extremely well, and that's the problem. A fake bonus notice
in a year with a pay freeze causes real distress and real conversations at home before anyone
reaches the training page. It also poisons the next twelve months of genuine internal comms,
staff learn to distrust exactly the messages we need them to trust.

Offered an alternative that tests the same behaviour without the harm: a simulated
document-share notification referencing a real internal process. Accepted.`
        }
    ])
    await as('hank', 'approve_steps', { step_ids: hSimSteps, note: 'Programme design, guardrails and analytics schema. The guardrails are the reusable part - any client running awareness training needs them.' })
    await as('hank', 'bake_recipe', { id: hSim.id, note: 'Reusable: authorised simulation programme design with ethics guardrails and privacy-preserving analytics.' })
    note('Hank baked the simulation programme design')

    const hGov = await as('hank', 'start_recipe', { project: 'Internal: Security Awareness Programme', title: 'Governance review: what marketing data may and may not enter the martech stack' })
    const hGovSteps = await steps('hank', hGov.id, [
        {
            kind: 'decision', tokens: 1980, tags: ['governance', 'data-protection', 'cross-practice'],
            content: `# Governance ruling, health-adjacent and special-category data stays out of the marketing stack

**Trigger.** The Braze practice (Jesse/Saul, Cacao & Co.) asked whether allergen and dietary
preference data could sit as Braze custom attributes to personalise product recommendations. A
reasonable request, allergen-aware recommendations are genuinely better for the customer.

**Ruling: no.** Allergen and dietary data does not enter the marketing execution platform. It stays
in the CDP under restricted access, and the marketing stack receives only a derived, non-sensitive
flag (e.g. \`recommend_dairy_free: true\`).

**Reasoning.**
1. **Allergen data is health data in effect**, whatever it's labelled in the schema. A dietary
   restriction is frequently a medical fact about a person. Under UK GDPR Art. 9 that is
   special-category data, and the lawful bases available for marketing are not the ones available
   for special-category processing.
2. **The marketing stack has the widest access surface in the company.** Agency users, contractors,
   template authors, export tooling and webhooks all touch it. That is correct for campaign data
   and unacceptable for health data, and it's an access-control argument, not a vendor criticism.
3. **A derived flag preserves every bit of the customer benefit.** The recommendation engine needs
   to know *what to recommend*, not *why*. \`recommend_dairy_free\` does the job with none of the
   sensitivity.
4. **Blast radius.** If the marketing platform is ever breached, the difference between "attacker
   obtained email addresses and purchase history" and "attacker obtained health information about
   240,000 people" is the difference between an incident and a catastrophe.

**What the marketing team gets:** derived preference flags, refreshed nightly, documented in the
event contract as derived-not-source.

**What I owe them in return:** the derivation runs on our side and is available before their launch
date. A governance ruling that blocks work without providing the alternative isn't governance, it's
obstruction, and it teaches teams to route around security next time.`
        },
        {
            kind: 'doc', format: 'md', tokens: 1240, tags: ['security', 'analytics', 'reporting'],
            content: `# Q3 security awareness report, findings and what I'd change

**Coverage.** 3 campaigns, 1,240 employees, Tiers 1–2.

| Metric | Q2 | Q3 | Read |
|---|---|---|---|
| Click rate (T1) | 12.1% | 7.4% | Real improvement on obvious lures |
| Click rate (T2) | 24.8% | 21.2% | Modest. Expected, plausible lures are hard |
| **Report rate** | 9.2% | **31.6%** | **The result that matters** |
| Median time-to-report | 4h 10m | 51m | Detection capability roughly 5x better |
| Repeat clickers (2+) | 78 | 41 | Training routing is working |

**The headline is not the click rate.** Report rate tripling and time-to-report dropping to under
an hour means that if a real campaign lands, we now hear about it inside the window where
containment is still cheap. A 4-hour median gave an attacker most of a working day.

**What drove it**, in my judgement: the automated thank-you for every report, including false
positives. Q2 reporters got silence, so reporting felt like a waste of time. Cheap change, largest
single effect of anything we did.

**What I got wrong last quarter.** I reported click rate as the primary metric to the exec team.
It made the programme look worse than it was, and it pointed at the wrong intervention, "train
harder" instead of "make reporting effortless and rewarded." Fixed in this report; click rate is
now secondary.

**Recommendations.**
1. Phishing-resistant MFA on the remaining 210 accounts still on TOTP. **This matters more than
   any further awareness work**. Tier 3 results show a determined targeted lure defeats awareness,
   so the control has to be technical.
2. Keep the thank-you automation. Do not let anyone "optimise" it away.
3. One Tier 3 exercise in Q4, volunteer cohort, framed explicitly as testing our *controls* rather
   than our people.
4. Do **not** introduce a leaderboard. It was suggested; it converts a safety behaviour into a
   competition, and the losers stop reporting.`
        },
        {
            kind: 'steering', signal: 'affirm', tokens: 210, tags: ['review'],
            content: `Confirmed with the Braze practice that the derived-flag approach is workable for
their launch date. Jesse's event contract already documents allergen data as deliberately excluded,
which means the ruling landed as a design constraint rather than as a late veto. That's the outcome
I want from every governance conversation.`
        }
    ])
    await as('hank', 'approve_steps', { step_ids: hGovSteps, note: 'Governance ruling + Q3 report. The ruling constrains every practice, so it belongs in the company cookbook.' })
    await as('hank', 'bake_recipe', { id: hGov.id, note: 'Cross-practice: the special-category-data ruling applies to every martech engagement we run.' })
    note('Hank baked the governance ruling (cross-practice) and the Q3 analytics report')

    // ── Walter: AEM work, then head-chef curation ───────────────────────────
    phase('Walter White: AEM architecture, then curating as Head Chef')
    await as('walter', 'start_project', { name: 'Cacao & Co.: AEM Experience Platform', note: 'AEM as a Cloud Service. Editable templates, component library, headless delivery for the app.' })
    const wAem = await as('walter', 'start_recipe', { project: 'Cacao & Co.: AEM Experience Platform', title: 'Editable templates and component architecture for the chocolate storefront' })
    note(`Walter's recipe inherited practice: ${wAem.practice}`)
    const wAemSteps = await steps('walter', wAem.id, [
        {
            kind: 'decision', tokens: 2140, tags: ['aem', 'architecture', 'templates'],
            content: `# Decision, three editable templates, not eleven; and hybrid delivery, not headless-everything

**Context.** Cacao & Co. has 22 products, 6 campaign landing pages a quarter, an editorial "origins"
section, and a mobile app that needs the same content. The client's previous agency proposed eleven
static templates. The client's CTO wants "headless for everything."

## Decision 1: three editable templates

\`product-detail\`, \`campaign-landing\`, \`editorial-article\`. Everything else is achieved with
policies and a component library.

**Why.** Eleven templates is eleven places to make the same change. The real driver of template
proliferation is almost never genuine structural difference, it's authors wanting a different
*arrangement*, which is precisely what an editable template with well-designed policies gives them
without a developer. Three templates with a rich component set is more flexible than eleven rigid
ones, and it is one deployment instead of eleven when the brand refreshes.

**The constraint that makes this work:** policies must be genuinely restrictive. If every container
allows every component, authors build inconsistent pages and we end up with eleven templates again,
just implicitly and undocumented.

## Decision 2: hybrid delivery, not full headless

**Web pages: server-rendered AEM.** **App and in-store screens: GraphQL content fragments.**

**Why not headless for the web too**, as the CTO asked:
1. **SEO is this brand's primary acquisition channel.** Organic search for "single origin
   chocolate gift" is how they're found. Client-side-rendered content can be indexed, but it
   introduces a class of ranking risk for zero business upside on a content-led site.
2. **Authoring experience collapses.** Headless means authors lose in-context editing and preview.
   For a team of two marketers publishing six campaigns a quarter, that is the difference between
   self-service and a developer ticket per page, which will quietly become the actual cost of the
   architecture.
3. **The app genuinely needs headless**, and content fragments serve it properly. Hybrid isn't a
   compromise here; it's using each delivery model where it's strongest.

**What I told the CTO:** headless is the right answer to "many consumers of the same content." It's
the wrong answer to "one website that must rank." He accepted the distinction, and the deciding
argument was the authoring cost, not the SEO risk, because he could see the ticket queue.

## Decision 3: content fragments as the single source for product copy

Product descriptions, origin stories and tasting notes live in content fragments referenced by
both the AEM page and the app's GraphQL query. Written once, published everywhere. The alternative
copy maintained separately for web and app, diverges within one campaign cycle. It always does.`
        },
        {
            kind: 'diagram', format: 'mermaid', tokens: 1160, tags: ['aem', 'architecture', 'component-hierarchy'],
            content: `flowchart TD
    subgraph TPL["Editable templates (3)"]
        T1["product-detail"]
        T2["campaign-landing"]
        T3["editorial-article"]
    end
    subgraph POL["Policies gate what authors may place"]
        P1["hero: image | video | split<br/>(NOT carousel - never converts)"]
        P2["body: text, cf-ref, tasting-notes,<br/>origin-map, product-grid"]
        P3["cta: single primary per page<br/>(enforced, not advised)"]
    end
    subgraph CMP["Component library"]
        C1["tasting-notes<br/>(CF-backed)"]
        C2["origin-map"]
        C3["product-grid<br/>(CF query)"]
        C4["golden-ticket-claim<br/>(from Saul's promo work)"]
    end
    subgraph DEL["Delivery"]
        W["Web: server-rendered<br/>(SEO + in-context authoring)"]
        A["App / in-store: GraphQL<br/>content fragments"]
    end
    CF[("Content fragments<br/>SINGLE source of product copy")]

    T1 --> POL
    T2 --> POL
    T3 --> POL
    POL --> CMP
    CMP --> W
    CF --> C1
    CF --> C3
    CF --> A
    CF --> W`
        },
        {
            kind: 'code', language: 'java', format: 'java', tokens: 1520, tags: ['aem', 'sling-model', 'component'],
            content: `package com.cacao.core.models.impl;

import org.apache.sling.api.resource.Resource;
import org.apache.sling.models.annotations.Model;
import org.apache.sling.models.annotations.DefaultInjectionStrategy;
import org.apache.sling.models.annotations.injectorspecific.ValueMapValue;
import javax.annotation.PostConstruct;
import java.util.Collections;
import java.util.List;

/**
 * Backs the tasting-notes component. Reads a Content Fragment so the same copy serves the
 * web page and the app's GraphQL query - product copy has exactly one source.
 */
@Model(adaptables = Resource.class,
       adapters = TastingNotes.class,
       resourceType = "cacao/components/content/tasting-notes",
       defaultInjectionStrategy = DefaultInjectionStrategy.OPTIONAL)
public class TastingNotesImpl implements TastingNotes {

    @ValueMapValue private String fragmentPath;
    @ValueMapValue private String variation;

    private ContentFragmentAdapter fragment;

    @PostConstruct
    protected void init() {
        // A missing or unpublished fragment must degrade to an empty component, never a 500.
        // Authors reference fragments before publishing them constantly; a hard failure here
        // takes down the product page during a campaign launch.
        this.fragment = ContentFragmentAdapter.from(fragmentPath, variation);
    }

    @Override public boolean isReady() { return fragment != null && fragment.isValid(); }
    @Override public String getOrigin()   { return isReady() ? fragment.text("origin")   : ""; }
    @Override public String getCocoaPct() { return isReady() ? fragment.text("cocoaPct") : ""; }

    /** Tasting notes render as an ordered list; order is editorial and must be preserved. */
    @Override public List<String> getNotes() {
        return isReady() ? fragment.multiText("notes") : Collections.emptyList();
    }

    /** Allergen STATEMENT only - the legally required manufacturing notice. Never per-customer
     *  allergen data: that is special-category data and stays out of this stack entirely
     *  (see the security practice's governance ruling). */
    @Override public String getAllergenStatement() {
        return isReady() ? fragment.text("allergenStatement") : "";
    }
}`
        },
        {
            kind: 'config', format: 'conf', tokens: 940, tags: ['aem', 'dispatcher', 'caching'],
            content: `# Dispatcher. Cacao & Co. Excerpt covering the two rules that always get this wrong.

/cache {
  /docroot "/mnt/var/www/html"
  /statfileslevel "3"

  /rules {
    # Cache product and editorial pages aggressively - they change on a publish, not per-request.
    /0000 { /glob "*" /type "allow" }

    # NEVER cache the golden-ticket claim page. It renders per-entrant state and a CSRF token;
    # a cached copy would serve one entrant's token to another. This is the single most
    # dangerous line in this file and it is why it has a comment three times its length.
    /0010 { /glob "/promotions/golden-ticket/claim*" /type "deny" }

    # Campaign landing pages during an active promotion: short TTL rather than deny.
    # Authors publish copy fixes hourly in the first days of a campaign, and a 24h cache
    # means a wrong price stays up for a day.
    /0020 { /glob "/campaigns/*" /type "allow" /ttl "300" }
  }

  /invalidate {
    /0000 { /glob "*" /type "deny" }
    /0001 { /glob "*.html" /type "allow" }
    # Invalidate the whole product section when a content fragment changes - a fragment can be
    # referenced by pages we cannot enumerate from the fragment itself.
    /0002 { /glob "/products/*" /type "allow" }
  }
}

/filter {
  /0000 { /type "deny" /glob "*" }
  /0010 { /type "allow" /method "GET" /url "/content/cacao/*" }
  /0020 { /type "allow" /method "POST" /url "/promotions/golden-ticket/claim" }
  # Deliberately NOT allowed: /bin/*, /crx/*, /system/*, selectors on .json.
  # The .json selector deny is the one people forget, and it is how content trees leak.
  /0030 { /type "deny" /url "*.json" }
}`
        },
        {
            kind: 'steering', signal: 'correct', tokens: 380, tags: ['review', 'cto'],
            content: `Corrected after the CTO review: my first draft argued against full headless mainly
on SEO risk. He wasn't moved, his team believes they can solve indexing, and honestly they might.

What actually changed his mind was the authoring cost: two marketers, six campaigns a quarter, and
headless means every page becomes a developer ticket. I'd led with the technical risk when the
decisive argument was operational. Rewrote the decision record to lead with authoring cost and
keep SEO as supporting evidence.

Lesson for the practice: with a technical stakeholder, the winning argument is often the one about
*their team's time*, not the one about technical risk. They discount risk they believe they can
engineer around. They cannot engineer around headcount.`
        }
    ])
    await as('walter', 'approve_steps', { step_ids: wAemSteps, note: 'Reviewed with the client CTO. Template-count and hybrid-delivery reasoning are reusable on every AEM engagement.' })
    await as('walter', 'bake_recipe', { id: wAem.id, note: 'Reference architecture: three templates + hybrid delivery. Reusable.' })
    note('Walter baked the AEM reference architecture')

    // ── Head Chef curation ──────────────────────────────────────────────────
    phase('Head Chef curation: what becomes company doctrine')
    const pending = await as('walter', 'list_cx_pending')
    note(`CX queue: ${Array.isArray(pending) ? pending.length : 0} baked recipe(s) awaiting a head chef`)

    const admit = [
        [jCart.id, 'Margin-ranked cart recovery for perishable goods, with the absolute-deadline rule. Reusable on any DTC lifecycle engagement.'],
        [sPromo.id, 'The prize-competition-vs-lottery reasoning is the kind of thing that saves an engagement from a compliance incident. Company doctrine.'],
        [jTicket.id, 'Auditable prize issuance: the platform messages the outcome, it never rolls the dice. Applies well beyond Braze.'],
        [mArch.id, 'Eligibility as a hard filter, ranking as a score, never mixed. This is the decisioning practice\'s core principle.'],
        [hGov.id, 'The special-category-data ruling constrains every practice. Everyone needs to know this before they design a schema.'],
        [wAem.id, 'Three templates over eleven, and hybrid over headless-everything, with the authoring-cost argument. Reusable on every AEM build.']
    ]
    for (const [id, note_] of admit) await as('walter', 'headchef_approve', { recipe_id: id })
    note(`Walter admitted ${admit.length} recipes to the Company CX Graph`)

    // Held back deliberately - and the reason is the useful part.
    await as('mike', 'headchef_reject', { recipe_id: mProposal.id, note: 'Held back from the CX graph, not because it is weak, but because it contains a named client\'s commercial terms and day rates. The reusable pattern (phase with stop points, exclude what you cannot size) should be re-captured as a client-neutral playbook and admitted then.' })
    note('Mike (2nd head chef) held back the proposal: named client commercial terms don\'t belong in shared doctrine')

    await as('walter', 'rebuild_cx_graph', {})
    const graph = await as('walter', 'get_cx_graph', {})
    note(`Company CX Graph rebuilt: ${graph.nodes?.length ?? 0} nodes, ${graph.edges?.length ?? 0} edges`)

    // ── Work in flight, private, un-baked, exactly like a real Tuesday ─────
    phase('Work in progress: each consultant has something private on the go')
    const inflight = [
        ['jesse', 'Cacao & Co.: Lifecycle Activation', 'Bar of the Month, churn-save flow (WIP)', 'message',
            `Rough thinking, not ready for anyone else's eyes.

Skip is the signal we should be acting on, not cancel. By the time someone cancels they've
decided; a skip is ambivalence, and ambivalence is addressable. Three skips in a row is
functionally a cancellation nobody has processed yet.

Idea: on 2nd consecutive skip, offer a smaller format (single bar rather than three) instead of
a discount. Keeps them subscribed, keeps the habit, protects the price. Need to check with Saul
whether changing the shipment size mid-term needs a T&C amendment, probably does.

Open question I can't answer yet: is skip_reason='cost' better served by the smaller format or
by a pause? Pausing feels like losing them, but forcing a decision might lose them for real.`],
        ['saul', 'Cacao & Co.: Lifecycle Activation', 'Corporate gifting terms, draft (WIP, do not circulate)', 'doc',
            `Half-formed. Corporate gifting is a different animal: PO-based, VAT invoiced, bulk ship to
multiple addresses, and buyers who are procurement people rather than chocolate people.

Points to work through:
- Consumer distance-selling cancellation rights don't apply to a B2B purchase. Need a separate
  returns position, and it should be more generous than the law requires, not less, these are
  repeat annual buyers.
- Personalised sleeves: who owns the artwork the client uploads, and what do we do with it after?
  Proposing we delete on fulfilment + 90 days. Nobody ever asks for this and everybody should.
- Allergen statement must appear on every recipient-facing item, not just the invoice. The buyer
  is not the eater, that's the whole point of gifting, so the information has to travel with
  the product, not with the transaction.`],
        ['mike', 'Gustavo\'s Fine Foods. Offer Decisioning', 'Week-1 CDP data-quality assessment (in progress)', 'message',
            `Two days into the assessment. Early read, and I'd rather flag it now than in the report.

Consent data is worse than they think. Three systems (web preference centre, till loyalty signup,
app onboarding) and they disagree on roughly 9% of profiles I've sampled. Not edge cases, active
customers with a marketing opt-out in one system and an opt-in in another.

That's a Phase 1 blocker, not a Phase 3 nice-to-have, because eligibility is a hard filter and a
hard filter reading the wrong value is worse than no filter, it launders a bad decision through
a system that looks rigorous.

Recommendation forming: take the most restrictive value across all three, and put the
reconciliation on Gustavo's side with a named owner. Need to price the assessment properly before
I put a number in front of them.`],
        ['hank', 'Internal: Security Awareness Programme', 'Q4 Tier-3 exercise design (draft, volunteer cohort)', 'decision',
            `Drafting the Q4 Tier-3 exercise. Not shared yet, a Tier-3 design is itself sensitive, since
publishing the pretext in advance destroys the exercise.

Framing I want to land, and I need to get the wording right before anyone reads it: this exercise
tests our CONTROLS, not our people. If it succeeds, the finding is "awareness has a ceiling, fund
phishing-resistant MFA", not "staff failed again". I've seen these programmes curdle into a stick
to beat people with, and the moment that happens reporting collapses and we're blind.

Candidate pretext: a shared-document notification during audit season, referencing a genuine
internal process. Plausible, contextual, and, importantly, not emotionally abusive. It doesn't
touch pay, jobs, or family.

Still to decide: whether to tell the volunteer cohort the month. Telling them makes it a fair
test of controls. Not telling them makes it a better test of behaviour. I lean towards telling
them, because consent is what separates this from the thing we're defending against.`],
        ['walter', 'Cacao & Co.: AEM Experience Platform', 'Content fragment model for origin stories (WIP)', 'code',
            `{
  "_comment": "DRAFT, not reviewed, not published. Modelling the origins editorial content.",
  "modelPath": "/conf/cacao/settings/dam/cfm/models/origin-story",
  "fields": [
    { "name": "originCountry", "type": "text", "required": true },
    { "name": "cooperative",   "type": "text", "required": false,
      "hint": "Named only with the cooperative's written permission, check with legal before this ships publicly" },
    { "name": "harvestNotes",  "type": "multitext", "format": "richtext" },
    { "name": "farmerPhotos",  "type": "contentref", "multi": true,
      "hint": "OPEN QUESTION: consent + usage rights for photographs of named individuals. Do NOT publish this model until answered. Asking Hank whether this counts as personal data. I think it does." }
  ]
}`]
    ]
    for (const [persona, project, title, kind, content] of inflight) {
        const r = await as(persona, 'start_recipe', { project, title })
        await as(persona, 'append_step', { recipe_id: r.id, kind, content, source: 'ide-agent', model: 'opus-5', tokens_used: 640 })
    }
    note(`${inflight.length} private work-in-progress recipes left un-baked, one per consultant`)

    // ── Verify the dataset behaves like a real multi-tenant cookbook ────────
    phase('Verification: does the dogfooded dataset behave correctly?')
    const jPrivate = await as('jesse', 'list_recipes', {})
    const sSees = await as('saul', 'list_recipes', {})
    const jTitles = new Set(jPrivate.map(r => r.title))
    const saulSeesJesseWip = sSees.some(r => r.title.includes('churn-save flow (WIP)'))
    note(`ISOLATION: Jesse sees his own WIP (${jTitles.has('Bar of the Month, churn-save flow (WIP)')}); Saul sees it: ${saulSeesJesseWip} (must be false)`)
    if (saulSeesJesseWip) failures++
    const jesseView = await as('jesse', 'list_recipes', {})
    const hankView = await as('hank', 'list_recipes', {})
    note(`Jesse sees ${jesseView.length} recipe(s); Hank sees ${hankView.length}, own work plus everyone's shared work`)

    const brazeOnly = await as('saul', 'list_recipes', { practice: 'braze' })
    const secOnly = await as('walter', 'list_recipes', { practice: 'security' })
    const aemOnly = await as('jesse', 'list_recipes', { practice: 'aem' })
    note(`practice filters: braze=${brazeOnly.length}, security=${secOnly.length}, aem=${aemOnly.length}, knowledge stays in its discipline`)

    const saulFinds = await as('saul', 'search_resources', { query: 'decisioning eligibility ranking' })
    note(`cross-practice reuse: Saul (braze) can find Mike's decisioning work, ${Array.isArray(saulFinds) ? saulFinds.length : 0} hit(s)`)

    const viewerGraph = await as('viewer', 'get_cx_graph', {})
    note(`read-only viewer can read the shared graph: ${viewerGraph.nodes?.length ?? 0} nodes`)
    await as('viewer', 'start_recipe', { project: 'x', title: 'y' }, { expectError: true })
    note('read-only viewer still cannot write')

    const skill = await as('jesse', 'export_as_skill', { recipe_id: jCart.id })
    note(`export_as_skill works on a baked recipe: ${typeof skill === 'string' ? skill.length : JSON.stringify(skill).length} chars of replayable playbook`)
}

main().then(() => {
    writeFileSync(join(HERE, 'dogfood-transcript.md'), [
        '# Dogfood transcript, five consultants, one week of work',
        '',
        `- **Target:** \`${MCP_URL}\``,
        '- Every call was made with that persona\'s **own api key**, over HTTPS, against the live deployment.',
        '- Keys are redacted. Generated by `validation/dogfood.mjs`.',
        '',
        '## Outcomes',
        '',
        ...notes.map(n => `- ${n}`),
        '',
        '## Full call log',
        '',
        ...log
    ].join('\n'))
    console.log(`\n${'='.repeat(60)}`)
    console.log(failures === 0 ? 'Dogfood run completed with no unexpected tool errors.' : `Dogfood run completed with ${failures} unexpected tool error(s).`)
    console.log('transcript -> validation/dogfood-transcript.md')
    process.exit(failures === 0 ? 0 : 1)
}).catch(e => { console.error(e); process.exit(1) })
