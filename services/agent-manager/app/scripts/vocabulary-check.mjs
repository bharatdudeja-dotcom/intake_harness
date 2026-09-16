/**
 * What cookbook vocabulary is still on screen.
 *
 * Renders every panel and walks TEXT NODES only, so attribute values, tool
 * names and stored types - which must keep their old spelling, because renaming
 * a stored value orphans every record written before the rename - are not
 * counted. What is left is what a person actually reads.
 */
import { JSDOM } from 'jsdom'
import fs from 'fs'

const html = fs.readFileSync(new URL('../web-src/index.html', import.meta.url), 'utf8')
const wrap = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] })
const mod = await import('./probe-fixtures.mjs')
const TOOLS = mod.TOOLS

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost:3000/' })
const { window: w } = dom
w.vis = {
  DataSet: class {
    constructor (rows = []) { this.rows = new Map((rows || []).map(r => [r.id, r])) }
    getIds () { return [...this.rows.keys()] }
    get (id) { return this.rows.get(id) || null }
    update (rows) { for (const r of (rows || [])) if (r) this.rows.set(r.id, { ...(this.rows.get(r.id) || {}), ...r }) }
  },
  Network: class { on () {} getConnectedNodes () { return [] } }
}
w.lucide = { createIcons () {} }
w.DOMPurify = { sanitize: (h) => String(h) }
w.marked = { parse: (t) => String(t), setOptions () {} }
w.hljs = { highlightElement () {}, highlightAll () {} }
w.fetch = async (url, opts = {}) => {
  let body = {}
  try { body = JSON.parse(opts.body || '{}') } catch (e) {}
  const name = body.params && body.params.name
  const result = Object.prototype.hasOwnProperty.call(TOOLS, name) ? wrap(TOOLS[name]) : wrap([])
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
await new Promise(r => w.addEventListener('load', r))
await sleep(250)
w.auth = w.auth || {}; w.auth.owner = 'bharat.dudeja@tapcxm.com'
try { await w.loadAll() } catch (e) {}
for (const fn of ['renderHome', 'renderProjects', 'renderWorklogList', 'renderTasks', 'renderCookbook', 'renderHeadChef', 'renderAgents', 'renderSettings', 'renderConnections']) {
  try { w[fn]() } catch (e) {}
}
try { await w.buildGraph() } catch (e) {}
try { await w.buildCx() } catch (e) {}
try { await w.openWorklog('recipe-live') } catch (e) {}
try { await w.openDetail('recipe-live') } catch (e) {}
await sleep(200)

const D = w.document
// 'ingr.' was missing from this list, which is why the audit reported clean
// while the panel dump plainly showed it. An audit worth having is one that
// fails when the thing it checks for is on screen.
const WORDS = /(recipes?|ingredients?|ingr|cookbook|head ?chefs?|chefs?|bakes?|baked|baking|cook-?off|test kitchen)/gi
const found = new Map()
const walker = D.createTreeWalker(D.body, 4 /* TEXT_NODE */)
let n
while ((n = walker.nextNode())) {
  const parent = n.parentElement
  if (!parent || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') continue
  const t = (n.textContent || '').replace(/\s+/g, ' ').trim()
  if (!t) continue
  const m = t.match(WORDS)
  if (!m) continue
  for (const word of m) {
    const key = word.toLowerCase()
    if (!found.has(key)) found.set(key, new Set())
    if (found.get(key).size < 3) found.get(key).add(t.slice(0, 120))
  }
}
if (!found.size) { console.log('CLEAN - no cookbook vocabulary on screen'); process.exit(0) }
console.log('words still visible:', [...found.keys()].join(', '), '\n')
for (const [word, samples] of found) {
  for (const s of samples) console.log(word.padEnd(12) + ' | ' + s)
}
process.exit(1)
