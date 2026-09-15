/*
Copyright 2026 Adobe. All rights reserved.
Licensed under the Apache License, Version 2.0.
*/

/**
 * CONTRAST CHECK (D84) - reads the real palettes out of web-src/index.html and asserts that every
 * foreground/background pair the dashboard actually renders clears WCAG AA.
 *
 * Written because status colour was being judged by eye. Measured, the original palette failed in
 * 13 places in light mode and 5 in dark - "experimental" sat at 2.86:1 - which is why status read
 * as washed-out decoration instead of information. A palette is a contract with the reader, and a
 * contract nobody checks is a wish.
 *
 *   node scripts/contrast-check.mjs
 *
 * Exits non-zero on any failure, so it belongs beside lint and portability-check.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HTML = join(HERE, '..', 'web-src', 'index.html')

/** WCAG relative luminance / contrast ratio. */
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16)
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

/**
 * Extract `--token: #RRGGBB` declarations from one CSS rule block.
 * @param {string} css @param {string} selector @returns {Record<string,string>}
 */
function tokensIn (css, selector) {
    const start = css.indexOf(selector)
    if (start === -1) throw new Error(`selector ${selector} not found in web-src/index.html`)
    const open = css.indexOf('{', start)
    const close = css.indexOf('}', open)
    const block = css.slice(open + 1, close)
    const out = {}
    for (const m of block.matchAll(/--([\w-]+)\s*:\s*(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2].toUpperCase()
    return out
}

const html = readFileSync(HTML, 'utf8')
const light = tokensIn(html, ':root {')
const dark = tokensIn(html, '[data-theme="dark"]')
const periodic = tokensIn(html, '[data-theme="periodic"]')

/** [foreground, background, what it is, minimum ratio] - AA is 4.5 for text, 3.0 for UI edges. */
const PAIRS = [
    ['text', 'surface', 'body text on a card', 4.5],
    ['text', 'bg', 'body text on the page', 4.5],
    ['text', 'surface-2', 'text on surface-2', 4.5],
    ['text-2', 'surface', 'secondary text on a card', 4.5],
    ['text-2', 'surface-3', 'secondary text on surface-3', 4.5],
    ['muted', 'surface', 'muted text on a card', 4.5],
    ['muted', 'bg', 'muted text on the page', 4.5],
    ['muted', 'surface-2', 'muted text on surface-2', 4.5],
    ['muted', 'surface-3', 'muted text on surface-3', 4.5],
    // Status badges: label on its own pill.
    ['house', 'house-soft', 'badge: in the CX graph', 4.5],
    ['exp', 'exp-soft', 'badge: experimental', 4.5],
    ['baked', 'baked-soft', 'badge: awaiting Head Chef', 4.5],
    ['affirm', 'affirm-soft', 'steering: affirm', 4.5],
    ['reject', 'reject-soft', 'steering: reject', 4.5],
    ['correct', 'correct-soft', 'steering: correct', 4.5],
    ['danger', 'danger-soft', 'danger badge', 4.5],
    ['accent-text', 'accent-soft', 'accent chip', 4.5],
    ['ready', 'ready-soft', 'badge: ready to bake', 4.5],
    ['ready', 'surface', 'ready colour as text on a card', 4.5],
    // The same status colours are also drawn as bare text/icons on cards and on the page.
    ['house', 'surface', 'house colour as text on a card', 4.5],
    ['house', 'bg', 'house colour as text on the page', 4.5],
    ['exp', 'surface', 'exp colour as text on a card', 4.5],
    ['exp', 'bg', 'exp colour as text on the page', 4.5],
    ['baked', 'surface', 'baked colour as text on a card', 4.5],
    ['reject', 'surface', 'reject colour as text on a card', 4.5],
    ['accent-text', 'surface', 'accent text on a card', 4.5]
]

/*
 * Structural check, not a colour one: a form control that sets a background but no colour is
 * painted in the BROWSER's default text colour, which is near-black. That shipped, and showed as
 * black labels on dark cards in Projects and the Work Log while every token around them was
 * correct. No palette audit can catch it, because the offending colour is not in the palette.
 */
function controlsWithoutColour (css) {
    const offenders = []
    for (const m of css.matchAll(/^([^@{}\n][^{}\n]*)\{([^}]*)\}/gm)) {
        const [, selector, body] = m
        if (!/(^|[\s,>])(button|input|select|textarea)\b|\.recipe-item|\.btn\b|\.chip\b|\.switcher|\.field/.test(selector)) continue
        // Skip state and variant rules (:hover, [aria-current], .primary...): they change one
        // property and correctly inherit colour from the base rule, which is what gets checked.
        if (/[:[]/.test(selector)) continue
        if (!/background\s*:/.test(body)) continue
        if (/(^|[;\s])color\s*:/.test(body)) continue
        offenders.push(selector.trim())
    }
    return offenders
}

let structural = 0
let failures = 0
const styleBlock = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
for (const selector of controlsWithoutColour(styleBlock)) {
    console.error(`✗ control sets a background but no colour, so it renders in the browser default: ${selector}`)
    structural++
}

for (const [theme, T] of [['light', light], ['dark', dark], ['periodic', periodic]]) {
    for (const [fg, bg, label, min] of PAIRS) {
        if (!T[fg] || !T[bg]) {
            console.error(`✗ ${theme}: missing token --${!T[fg] ? fg : bg}`)
            failures++
            continue
        }
        const r = ratio(T[fg], T[bg])
        if (r < min) {
            console.error(`✗ ${theme}: ${label} — ${r.toFixed(2)}:1, needs ${min}:1  (--${fg} ${T[fg]} on --${bg} ${T[bg]})`)
            failures++
        }
    }
}

if (structural) {
    console.error(`\n✗ Contrast check FAILED - ${structural} control(s) would render in the browser's default colour.`)
    console.error('  Give the base rule an explicit colour: a control that sets background but not colour is not themed.')
    process.exit(1)
}
if (failures) {
    console.error(`\n✗ Contrast check FAILED - ${failures} pair(s) below WCAG AA.`)
    console.error('  Move the FOREGROUND, not the soft background: lightening a pill drops its own label below AA.')
    process.exit(1)
}
console.log(`✓ Contrast check passed — ${PAIRS.length * 3} foreground/background pairs clear WCAG AA in all three themes.`)
