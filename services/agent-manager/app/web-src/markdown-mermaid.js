/*
Copyright 2026 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

/**
 * Classifies a fenced markdown code block so the dashboard can render a diagram embedded
 * inside a doc/architecture-doc/message body as a picture instead of a code block (D57/D58).
 * Plain <script>-loaded (no build step for web-src) - also required directly by tests.
 * @param {string} lang the fenced block's info-string language, e.g. "mermaid"
 * @param {string} text the fenced block's raw text content
 * @returns {'mermaid'|'svg'|null} 'mermaid' to render via mermaid.render, 'svg' to inject
 *   the markup directly (post-sanitization), null to fall back to a plain code block
 */
function pickDiagramKind (lang, text) {
    const l = (lang || '').trim().toLowerCase()
    const t = (text || '').trim()
    if (!t) return null
    if (l === 'mermaid') return 'mermaid'
    if (l === 'svg' && t.startsWith('<svg')) return 'svg'
    return null
}

/**
 * Mermaid diagram-type keywords a valid source can start with (mermaid 10.x). Used to strip
 * any prose an authoring AI mistakenly prepended to a format:"mermaid" step's content before
 * handing it to mermaid.render (D63) - mermaid can't parse narrative text and throws
 * "Syntax error in text", so we render from the first real diagram line onward.
 * @type {string[]}
 */
const MERMAID_KEYWORDS = [
    'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'stateDiagram',
    'erDiagram', 'journey', 'gantt', 'pie', 'mindmap', 'timeline', 'quadrantChart', 'gitGraph',
    'requirementDiagram', 'C4Context', 'sankey-beta', 'xychart-beta', 'block-beta'
]

/**
 * Extracts just the mermaid diagram source from a content string, dropping any leading prose
 * paragraphs (D63). Returns the substring from the first line whose first token is a mermaid
 * diagram-type keyword; if none is found, returns the trimmed input unchanged (let mermaid
 * try and fail naturally rather than silently blanking legitimate-but-unrecognized content).
 * @param {string} content the raw step content (may be prose + diagram, or diagram only)
 * @returns {string} the mermaid source to render
 */
function extractMermaidSource (content) {
    const text = (content || '').replace(/\r\n/g, '\n')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const firstToken = lines[i].trim().split(/[\s({]/)[0]
        if (firstToken && MERMAID_KEYWORDS.includes(firstToken)) {
            return lines.slice(i).join('\n').trim()
        }
    }
    return text.trim()
}

/**
 * True when a step's `format` means its `content` is raw diagram SOURCE (svg/mermaid), not
 * prose (D63). Used by renderStepBody when a step carries BOTH an asset (the rendered image)
 * and content: raw diagram source must not be run through marked.parse as markdown, or
 * DOMPurify strips the tags and dumps the diagram's inner text as a stray paragraph under
 * the image (the duplicated-title bug). Such content is shown as a collapsed source block
 * instead. Anything else (doc/message prose) still renders as markdown.
 * @param {string} fmt the step's format (case-insensitive)
 * @returns {boolean}
 */
function isRawDiagramFormat (fmt) {
    const f = (fmt || '').toLowerCase()
    return f === 'svg' || f === 'mermaid'
}

/**
 * DOMPurify config for a captured <svg> diagram (D60/D61). Extends (does not replace) the
 * default profile so var(...) references, inline <style>, and text nodes survive - the
 * defaults are unsanitary to disable.
 * @type {{ADD_TAGS: string[], ADD_ATTR: string[]}}
 */
const SVG_SANITIZE_CONFIG = { ADD_TAGS: ['style'], ADD_ATTR: ['style'] }

/**
 * Wraps a sanitized SVG's markup in a scope div that defines the CSS variable names the
 * AI's SVG may reference (--surface-0/-1/-2, --text-primary/-secondary/-muted/-accent,
 * --border*, --font-*, --radius), aliased to the dashboard's own theme (D60/D61).
 * @param {string} sanitizedHtml already-DOMPurify'd SVG markup
 * @returns {string} the markup wrapped in a `.svg-scope` container
 */
function wrapSvgScope (sanitizedHtml) {
    return `<div class="svg-scope">${sanitizedHtml}</div>`
}

/**
 * Mermaid themeVariables for a given dashboard theme so node/edge labels are always
 * legible on their node fill (D60/D61) - no black-on-black or white-on-white text.
 * Values mirror the dashboard's own light/dark palette (index.html :root / [data-theme=dark]).
 * @param {'light'|'dark'} theme
 * @returns {object} mermaid themeVariables
 */
function mermaidThemeVariables (theme) {
    const dark = theme === 'dark'
    return {
        background: dark ? '#262624' : '#FFFFFF',
        primaryColor: dark ? '#2B2A28' : '#F5F4EE',
        primaryTextColor: dark ? '#EDEAE3' : '#1F1E1C',
        primaryBorderColor: dark ? '#47453F' : '#D8D4C8',
        secondaryColor: dark ? '#32312E' : '#EFEDE5',
        secondaryTextColor: dark ? '#EDEAE3' : '#1F1E1C',
        tertiaryColor: dark ? '#3A2C24' : '#F7E8E1',
        tertiaryTextColor: dark ? '#EDEAE3' : '#1F1E1C',
        lineColor: dark ? '#8C877E' : '#85807A',
        textColor: dark ? '#EDEAE3' : '#1F1E1C',
        edgeLabelBackground: dark ? '#262624' : '#FFFFFF'
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { pickDiagramKind, extractMermaidSource, isRawDiagramFormat, wrapSvgScope, mermaidThemeVariables, SVG_SANITIZE_CONFIG }
}
