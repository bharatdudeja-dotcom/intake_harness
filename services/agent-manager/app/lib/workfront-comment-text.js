/*
 * Workfront's comment stream is not an HTML field.
 *
 * A comment went through the gateway as
 * "<p><strong>Correction to Agent 1's intake capture:</strong>..." and Workfront
 * rendered it with the tags visible, on one line, in a thread real reviewers
 * read. The client was not being careless - an HTML body is what comment fields
 * take almost everywhere else, and nothing on our side said otherwise.
 *
 * The server instructions now say otherwise, but instructions are advice and
 * this is a write to a customer's tenant that cannot be taken back: the comment
 * stream has no edit-in-place, so a mangled comment stays in the thread
 * forever. So markup is converted rather than merely discouraged.
 *
 * Only a body that actually contains tags is touched. A plain-text comment
 * passes through byte for byte, because rewriting what someone asked to send is
 * a liberty worth taking exactly once - when the alternative is visibly broken.
 */

/** The tools across the Workfront flavours that post prose a human will read. */
const COMMENT_TOOLS = /(^|_)(create_comment|add_comment|comments_create|reply)$/i

/** Where those tools carry the body. Different flavours name it differently. */
const COMMENT_ARGS = ['message', 'text', 'body', 'comment', 'note']

const HAS_MARKUP = /<[a-z/][^>]*>/i

/**
 * HTML in, readable text out.
 *
 * Block tags become the line breaks the author intended, so the structure
 * survives even though the styling cannot. Entities are decoded, because
 * "&amp;" in a sentence is the same class of leak as "<strong>".
 */
function asPlainText (html) {
  return String(html)
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim()
}

/**
 * Leave every argument alone except a comment body carrying markup.
 *
 * Returns the args to send and which key was rewritten, so the caller can say
 * so. A silent rewrite of what someone asked to post would be its own problem:
 * the assistant would then describe a comment that does not exist.
 */
function flattenCommentMarkup (tool, args) {
  if (!COMMENT_TOOLS.test(String(tool)) || !args || typeof args !== 'object') {
    return { args, flattened: null }
  }
  const key = COMMENT_ARGS.find(k => typeof args[k] === 'string' && HAS_MARKUP.test(args[k]))
  if (!key) return { args, flattened: null }

  const plain = asPlainText(args[key])
  // An empty result means the body was nothing but markup. Sending the original
  // is better than posting a blank comment and reporting success.
  if (!plain || plain === args[key]) return { args, flattened: null }

  return { args: { ...args, [key]: plain }, flattened: key }
}

module.exports = { asPlainText, flattenCommentMarkup, COMMENT_TOOLS, COMMENT_ARGS }
