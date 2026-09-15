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
 * Cookbook user accounts (D81): an admin creates a login id + password for each consultant, and
 * that login is what identifies them everywhere - dashboard and MCP client alike. This replaces
 * the shared deployment passcode, which told us only that someone was allowed in, never who.
 *
 * Passwords are stored as scrypt hashes with a per-user random salt. A plaintext or reversibly
 * encrypted password would make this store a credential dump, so verification only ever compares
 * hashes, and comparison is timing-safe. Node's own crypto is used deliberately - no new
 * dependency, and nothing here is coupled to a host or an IdP (D21/D34): the record shape is
 * plain JSON and lives behind lib/store.js like every other persisted thing.
 *
 * This is a local account system, NOT a replacement for enterprise SSO. Adobe IMS remains the
 * intended production path (parked, see D78); these accounts exist so the Cookbook is usable by a
 * real team today without waiting on it.
 */

const crypto = require('crypto')

/** scrypt cost parameters. N=16384 is a deliberate, ordinary choice: strong enough that a stolen
 *  store isn't trivially crackable, cheap enough to run inside a serverless request budget. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }
const SALT_BYTES = 16
const MIN_PASSWORD = 8

/**
 * Normalize a login id: lowercase, trimmed. Login ids are case-insensitive because a person who
 * types "Jesse" and a person who types "jesse" are the same person, and a login that depends on
 * capitalisation generates support tickets forever.
 * @param {string} id
 * @returns {string}
 */
function normalizeId (id) {
    return String(id || '').trim().toLowerCase()
}

/**
 * Hash a password with a fresh random salt.
 * @param {string} password
 * @returns {{salt: string, hash: string, algo: string}}
 */
function hashPassword (password) {
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex')
    const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex')
    return { salt, hash, algo: `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}` }
}

/**
 * Verify a candidate password against a stored record, in constant time.
 * @param {string} password
 * @param {{salt?: string, hash?: string}} record
 * @returns {boolean}
 */
function verifyPassword (password, record) {
    if (!record || !record.salt || !record.hash) return false
    const candidate = crypto.scryptSync(String(password), record.salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
    const stored = Buffer.from(record.hash, 'hex')
    // timingSafeEqual throws on a length mismatch, which would itself leak length information.
    if (candidate.length !== stored.length) return false
    return crypto.timingSafeEqual(candidate, stored)
}

/**
 * Validate a requested password. Deliberately minimal: a length floor catches the genuinely
 * dangerous case, while composition rules ("one symbol, one digit") mostly produce Password1!
 * and a sticky note.
 * @param {string} password
 * @returns {{ok: boolean, error?: string}}
 */
function checkPasswordStrength (password) {
    const p = String(password || '')
    if (p.length < MIN_PASSWORD) {
        return { ok: false, error: `Password must be at least ${MIN_PASSWORD} characters.` }
    }
    if (/^\s|\s$/.test(p)) {
        return { ok: false, error: 'Password must not start or end with a space (it is almost always a copy-paste accident).' }
    }
    return { ok: true }
}

/**
 * Build a new user record. Pure - the caller persists it.
 * @param {{id: string, email?: string, password: string, roles?: string[], practices?: string[], created_by?: string, display_name?: string}} input
 * @returns {{ok: boolean, error?: string, user?: object}}
 */
function buildUser (input) {
    const id = normalizeId(input && input.id)
    if (!id) return { ok: false, error: 'A login id is required.' }
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) {
        return { ok: false, error: `Invalid login id '${id}'. Use 2-64 characters: letters, numbers, dot, dash or underscore.` }
    }
    const strength = checkPasswordStrength(input.password)
    if (!strength.ok) return { ok: false, error: strength.error }

    const email = String(input.email || '').trim()
    const roles = Array.isArray(input.roles) ? input.roles.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim()) : []
    const practices = Array.isArray(input.practices) ? input.practices.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()) : []
    const { salt, hash, algo } = hashPassword(input.password)

    return {
        ok: true,
        user: {
            id,
            // The owner identity used everywhere else in the Cookbook. Prefer email so a user
            // created here matches the same person arriving later via SSO on their email claim.
            owner: email || id,
            email,
            display_name: String(input.display_name || '').trim() || '',
            roles,
            practices,
            salt,
            hash,
            algo,
            created_by: String(input.created_by || '').trim() || 'unknown',
            created_at: new Date().toISOString(),
            password_updated_at: new Date().toISOString(),
            disabled: false
        }
    }
}

/**
 * Strip every secret from a user record so it is safe to return over the wire or log. Anything
 * that leaves this module for a caller's eyes goes through here.
 * @param {object} user
 * @returns {object}
 */
function publicUser (user) {
    if (!user) return null
    const { id, owner, email, display_name: displayName, roles, practices, created_by: createdBy, created_at: createdAt, password_updated_at: passwordUpdatedAt, disabled } = user
    return { id, owner, email, display_name: displayName, roles, practices, created_by: createdBy, created_at: createdAt, password_updated_at: passwordUpdatedAt, disabled: !!disabled }
}

/**
 * Authenticate a login id + password against a user list.
 * @param {object[]} users
 * @param {string} id
 * @param {string} password
 * @returns {{ok: boolean, error?: string, user?: object}}
 */
function authenticate (users, id, password) {
    const wanted = normalizeId(id)
    const user = (users || []).find(u => normalizeId(u.id) === wanted)
    // Same message whether the id is unknown or the password is wrong: distinguishing them tells
    // an attacker which half to keep trying.
    const generic = { ok: false, error: 'Incorrect login id or password.' }
    if (!user) return generic
    if (user.disabled) return { ok: false, error: 'This login has been disabled. Ask an admin to re-enable it.' }
    if (!verifyPassword(password, user)) return generic
    return { ok: true, user }
}

module.exports = {
    normalizeId,
    hashPassword,
    verifyPassword,
    checkPasswordStrength,
    buildUser,
    publicUser,
    authenticate,
    MIN_PASSWORD
}
