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
 * Cached remote JWKS resolver, isolated in its own module so tests can mock it
 * (jest.mock('./jwks')) and inject a `createLocalJWKSet` key resolver instead -
 * exercising real jose signature verification against a locally-known keypair
 * without any network calls.
 */

const { createRemoteJWKSet } = require('jose')

const JWKS_CACHE = new Map() // jwksUri -> jose key resolver

/**
 * @param {string} jwksUri
 * @returns {import('jose').JWTVerifyGetKey}
 */
function getJwks (jwksUri) {
    if (!JWKS_CACHE.has(jwksUri)) {
        JWKS_CACHE.set(jwksUri, createRemoteJWKSet(new URL(jwksUri)))
    }
    return JWKS_CACHE.get(jwksUri)
}

module.exports = { getJwks }
