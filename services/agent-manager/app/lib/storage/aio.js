/**
 * Adobe I/O Files driver — the original host, kept as an option.
 *
 * Deliberately a pass-through: aio-lib-files IS the interface the other
 * drivers imitate, so there is nothing to translate.
 */

const filesLib = require('@adobe/aio-lib-files')

async function init () {
  return filesLib.init()
}

module.exports = { init }
