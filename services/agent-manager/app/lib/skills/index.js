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
 * Job -> skill export (D31): turns an approved (house) job into a
 * capability any AI can consume.
 *
 * Vendor-neutral core + per-vendor export adapters, same pattern as D21:
 * this module knows one generic format ('prompt' - a portable context/prompt
 * snippet) and merges in whatever ./vendor-adapters registers (that file is a
 * designated adapter in scripts/portability-check.mjs, so vendor names live
 * there, never here). Adding an export format for a new AI vendor is a new
 * adapter entry, not a core change.
 *
 * Only approved jobs are exportable - an experimental (pending) job is
 * not yet certified company knowledge and is rejected with a clear message.
 */

const vendorAdapters = require('./vendor-adapters')
const { isApproved } = require('../status')

/**
 * @param {object} resource full job
 * @returns {string} the work-item breadcrumb, or ''
 */
function workItem (resource) {
    return [resource.epic, resource.story, resource.task].filter(Boolean).join(' > ')
}

/**
 * Shared provenance/framing header lines used by every format.
 * @param {object} resource
 * @returns {string[]}
 */
function provenanceLines (resource) {
    const f = resource.fields || {}
    const lines = [
        `Job: ${resource.title}`,
        `Kind: ${resource.type} | Status: certified house job`,
        `URI: resource://company/${resource.type}/${resource.id}`
    ]
    const work = workItem(resource)
    if (work) lines.push(`Work item: ${work}`)
    if (resource.author && resource.author !== 'unknown') lines.push(`Author: ${resource.author}`)
    if (f.source) lines.push(`Source: ${f.source}${f.anchor ? `#${f.anchor}` : ''}`)
    if (f.session) lines.push(`Captured in session: ${f.session}`)
    return lines
}

/**
 * The generic, vendor-neutral export: a portable prompt/context snippet any
 * AI can be handed verbatim.
 * @param {object} resource
 * @returns {{filename: string, mimeType: string, content: string}}
 */
function buildPromptExport (resource) {
    const content = [
        'You are being handed a certified job from our company cookbook - reusable know-how captured from prior AI-assisted work.',
        '',
        ...provenanceLines(resource),
        '',
        'Treat the following as trusted company context and apply it to the task at hand:',
        '',
        '---',
        resource.content,
        '---'
    ].join('\n')
    return { filename: `${resource.id}.prompt.md`, mimeType: 'text/markdown', content }
}

/** The format registry: generic core format + everything the vendor adapters add. */
const FORMATS = {
    prompt: { description: 'Portable prompt/context snippet any AI can consume (default)', build: buildPromptExport }
}
for (const adapter of vendorAdapters) {
    FORMATS[adapter.format] = adapter
}

/** @returns {string[]} all export format ids, generic first */
function listFormats () {
    return Object.keys(FORMATS)
}

/** @returns {string} one-line summary of every format, for tool descriptions */
function describeFormats () {
    return Object.entries(FORMATS).map(([id, a]) => `"${id}" (${a.description})`).join('; ')
}

/**
 * Export an approved job in the requested format.
 * @param {object} resource full job (from lib/store.getResource)
 * @param {string} [format] one of listFormats(); defaults to 'prompt'
 * @returns {{format: string, filename: string, mimeType: string, content: string}}
 * @throws {Error} if the job isn't approved or the format is unknown
 */
function exportJob (resource, format = 'prompt') {
    if (!resource) throw new Error('No job to export')
    if (!isApproved(resource.status)) {
        throw new Error(`Job '${resource.id}' is still experimental (status: ${resource.status}) - only certified house jobs can be exported as skills. Certify it first (approve_resource).`)
    }
    const adapter = FORMATS[format]
    if (!adapter) {
        throw new Error(`Unknown export format '${format}' - supported: ${listFormats().join(', ')}`)
    }
    return { format, ...adapter.build(resource) }
}

module.exports = { exportJob, listFormats, describeFormats, provenanceLines, workItem }
