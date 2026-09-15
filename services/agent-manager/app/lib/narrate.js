/**
 * Turning an upstream step into something a person can read.
 *
 * The cookbook demo that started this project logged narrative: titled
 * decisions, a field table with a Source column, corrections with what they
 * cost, a wait log, a time ledger. A reviewer could read it top to bottom and
 * understand what happened.
 *
 * The first cut of start_intake logged `JSON.stringify(upstream)`. Technically
 * complete, and useless to read - which defeats the point of keeping a record
 * at all.
 *
 * So this module writes markdown: a heading, what the stage actually did, a
 * field table where there are fields, and the raw payload kept underneath as
 * evidence rather than as the headline.
 *
 * Nothing here invents content. Every line is derived from what the upstream
 * returned, and where a value was inferred rather than stated, the table says
 * so - a brief that looks complete because the agent guessed is exactly the
 * failure the record exists to catch.
 */

/** Values that are answers in form but not in substance. */
const AMBIGUOUS = ['not sure', 'unknown', 'n/a', 'tbc', 'tbd', 'none', '']

function isAmbiguous (value) {
    return AMBIGUOUS.includes(String(value == null ? '' : value).trim().toLowerCase())
}

function short (value, max = 220) {
    if (value == null) return ''
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Markdown table cells must not break the table. */
function cell (value) {
    return short(value).replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

function seconds (ms) {
    if (ms == null) return '—'
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * Flatten an output object one level into rows, so a stage's result reads as a
 * table rather than a blob. Nested objects are summarised, not expanded - the
 * raw payload is kept below for anyone who needs the whole thing.
 */
function rows (output) {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return []
    return Object.entries(output).map(([key, value]) => {
        let note = 'stated by the agent'
        if (value == null) note = '**not set**'
        else if (isAmbiguous(value)) note = '**ambiguous** — does not identify anything'
        else if (typeof value === 'object' && value && (value.error || value.err)) note = '**failed**'
        return { key, value: cell(value), note }
    })
}

/**
 * One stage of a run, as markdown.
 *
 * @param {object} step normalised step (see agent-systems.toSteps)
 * @param {string} label the agent's display name, from the upstream registry
 * @returns {string} markdown
 */
function narrateStep (step, label) {
    const faulted = !!step.embedded_error
    const heading = faulted
        ? `### ${label} — reported success, but its tool call failed`
        : `### ${label}`

    const lines = [heading, '']

    lines.push(
        `**Reported:** \`${step.upstream_status}\`  ·  ` +
        `**Actually:** ${faulted ? '`faulted`' : `\`${step.upstream_status}\``}  ·  ` +
        `**Took:** ${seconds(step.duration_ms)}`
    )
    lines.push('')

    if (faulted) {
        lines.push(
            `The step returned \`${step.upstream_status}\`, but its output carries an error:`,
            '',
            `> ${short(step.embedded_error, 400)}`,
            '',
            'The failure was written into the payload instead of being raised, so the ' +
            'pipeline carried on and the run reads as a success. Nothing downstream was ' +
            'told, and because the status never became `failed`, the escalation agent was ' +
            'never invoked.',
            ''
        )
    }

    const table = rows(step.output)
    if (table.length) {
        lines.push('**What it produced**', '')
        lines.push('| Field | Value | Source |', '|---|---|---|')
        for (const r of table) lines.push(`| ${r.key} | ${r.value} | ${r.note} |`)
        lines.push('')
    }

    const flagged = table.filter(r => r.note.startsWith('**'))
    if (flagged.length) {
        lines.push(
            `${flagged.length} of ${table.length} field${table.length === 1 ? '' : 's'} ` +
            `${flagged.length === 1 ? 'is' : 'are'} unset, ambiguous or failed: ` +
            `${flagged.map(f => f.key).join(', ')}.`,
            ''
        )
    }

    if (step.metadata && Object.keys(step.metadata).length) {
        const loop = step.metadata.loopCount
        if (loop != null) {
            lines.push(
                `**Loop count:** ${loop}` +
                (Number(loop) > 2
                    ? ' — above two rounds. Per B1 that means the agent failed, not the marketer.'
                    : ''),
                ''
            )
        }
    }

    lines.push(
        '<details><summary>Raw upstream payload</summary>',
        '',
        '```json',
        JSON.stringify({ input: step.input, output: step.output, metadata: step.metadata }, null, 2),
        '```',
        '',
        '</details>'
    )

    return lines.join('\n')
}

/**
 * The opening artifact: the marketer's brief, verbatim, and what it was sent to.
 * Captured before any agent touches it, because everything downstream is judged
 * against it.
 */
function narrateBrief (brief, system) {
    return [
        '### The brief, as the marketer wrote it',
        '',
        '> ' + String(brief).trim().split('\n').join('\n> '),
        '',
        `Sent to **${system.label || system.id}** at \`${system.base_url}\`. ` +
        'Captured verbatim before any agent touched it, so every later stage can be ' +
        'read against what was actually asked for.'
    ].join('\n')
}

/**
 * The closing artifact: where the time went and what is unresolved.
 * The cookbook demo called this the time ledger, and it is the thing that
 * answers "why did this take two weeks" - so it is worth writing every run,
 * even when the answer is "it took four seconds".
 */
function narrateLedger (steps, opts = {}) {
    const total = steps.reduce((n, s) => n + (s.duration_ms || 0), 0)
    const faults = steps.filter(s => s.embedded_error)

    const lines = ['### Time ledger', '']
    lines.push('| Stage | Took | Reported | Actually |', '|---|---|---|---|')
    for (const s of steps) {
        lines.push(
            `| ${opts.labelFor ? opts.labelFor(s.agent_id) : s.agent_id} | ${seconds(s.duration_ms)} ` +
            `| ${s.upstream_status} | ${s.embedded_error ? '**faulted**' : s.upstream_status} |`
        )
    }
    lines.push('', `**Total agent time:** ${seconds(total)}.`, '')

    if (faults.length) {
        lines.push(
            `**${faults.length} stage${faults.length === 1 ? '' : 's'} reported success while failing.** ` +
            'A per-run view records this run as clean. Only reading across runs shows that the ' +
            'same tool has failed every time.',
            ''
        )
    } else {
        lines.push('No stage contradicted its own status this run.', '')
    }

    if (opts.settled === false) {
        lines.push('The pipeline had not finished when this was written. Call `get_intake` for the rest.', '')
    }
    return lines.join('\n')
}

module.exports = { narrateStep, narrateBrief, narrateLedger, seconds }
