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
 * The capture paths must not call functions that do not exist.
 *
 * WHY THIS FILE EXISTS
 *
 * Twice in one day, a capture path called a function that was not there:
 *
 *   stepsLib.make(...)   never existed at all
 *   projectRecipe(...)   renamed to projectJob and not updated here
 *
 * Both sat inside `try { ... } catch (e) { }`, so both threw ReferenceError or
 * TypeError into silence. The pipeline advanced, the tool reported the stages,
 * and nothing was written down. An assistant then refused to describe an
 * audience that had been built correctly, because every attempt to read it came
 * back empty or erroring - which was the right call on what it could see.
 *
 * A unit test cannot easily drive these paths end to end (they need a live
 * upstream), and that is exactly why the bugs survived. So this reads the
 * source instead: every function called inside the capture helpers must be
 * defined in the module or be a known import. It is a crude check, and it would
 * have caught both.
 */

const fs = require('fs')
const path = require('path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'actions', 'mcp-server', 'tools.js'), 'utf8')

/** Names that are defined in the module, imported, or built into the runtime. */
function knownNames (src) {
    const known = new Set([
        // runtime + language
        'require', 'Boolean', 'String', 'Number', 'Array', 'Object', 'JSON', 'Date', 'Set', 'Map',
        'Promise', 'Error', 'isFinite', 'parseInt', 'parseFloat', 'fetch', 'console', 'setTimeout',
        'clearTimeout', 'encodeURIComponent', 'decodeURIComponent', 'structuredClone', 'z',
        'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function', 'of', 'in'
    ])
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) known.add(m[1])
    for (const m of src.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm)) known.add(m[1])
    for (const m of src.matchAll(/^const\s+\{([^}]+)\}\s*=\s*require\(/gm)) {
        for (const part of m[1].split(',')) known.add(part.split(':').pop().trim())
    }
    for (const m of src.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/gm)) known.add(m[1])
    // locally scoped helpers declared inside functions
    for (const m of src.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g)) known.add(m[1])
    return known
}

/** The body of a named function declaration, by brace matching. */
function bodyOf (src, name) {
    const start = src.search(new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\('))
    if (start === -1) return null
    let i = src.indexOf('{', start)
    let depth = 0
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1) }
    }
    return null
}

describe('capture paths call only functions that exist', () => {

    const known = knownNames(SRC)

    test('captureStages has no dangling calls', () => {
        const body = bodyOf(SRC, 'captureStages')
        expect(body).toBeTruthy()

        const called = [...body.matchAll(/(?:^|[^.\w$])([a-z][\w$]*)\s*\(/g)].map(m => m[1])
        const dangling = [...new Set(called)].filter(n => !known.has(n))
        // projectRecipe was here, renamed to projectJob everywhere but this line.
        expect(dangling).toEqual([])
    })

    test('the old pre-rename names are gone from every call site', () => {
        // The rename that broke this: recipe -> job.
        expect(SRC).not.toMatch(/\bprojectRecipe\s*\(/)
        expect(SRC).not.toMatch(/\bbake_recipe\s*\(/)
    })

    test('stepsLib.make exists and is called with a job id and an order', () => {
        const steps = require('../lib/steps.js')
        expect(typeof steps.make).toBe('function')
        // Every call passes (jobId, order, fields) - a bare make({...}) is the
        // signature that silently produced steps with no id.
        for (const m of SRC.matchAll(/stepsLib\.make\(([^)]*)\)/g)) {
            expect(m[1]).toMatch(/,/)
            expect(m[1].trim()).not.toMatch(/^\{/)
        }
    })

    test('captureStages reports failure instead of swallowing it', () => {
        const body = bodyOf(SRC, 'captureStages')
        // An empty catch is what hid both bugs.
        expect(body).toMatch(/return \{ added: 0, error:/)
        expect(body).toMatch(/return \{ added, error: null \}/)
    })
})
