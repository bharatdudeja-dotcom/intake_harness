const { asPlainText, flattenCommentMarkup } = require('../lib/workfront-comment-text.js')

/*
 * A comment is a write to a customer's tenant with no edit-in-place. Getting it
 * wrong is visible to the people the demo is for, permanently, in a thread they
 * read. That is why the conversion is tested rather than trusted.
 */
describe('Workfront comment bodies', () => {

    describe('asPlainText', () => {

        test('the comment that actually shipped, as Workfront showed it', () => {
            // Verbatim from the tenant: tags rendered literally, on one line,
            // in the middle of a human conversation.
            const sent = "<p><strong>Correction to Agent 1's intake capture:</strong></p>" +
                '<p>Region should be Pennsylvania, not the whole Northeast.</p>'
            expect(asPlainText(sent)).toBe(
                "Correction to Agent 1's intake capture:\nRegion should be Pennsylvania, not the whole Northeast."
            )
        })

        test('block tags become the line breaks the author meant', () => {
            expect(asPlainText('<p>one</p><p>two</p>')).toBe('one\ntwo')
            expect(asPlainText('a<br>b')).toBe('a\nb')
            expect(asPlainText('<h3>Heading</h3>body')).toBe('Heading\nbody')
        })

        test('list items keep their bullet', () => {
            expect(asPlainText('<ul><li>first</li><li>second</li></ul>')).toBe('- first\n- second')
        })

        test('entities are decoded - "&amp;" in a sentence leaks the same way a tag does', () => {
            expect(asPlainText('<p>Sales &amp; Service &lt;PA&gt;&nbsp;team</p>')).toBe('Sales & Service <PA> team')
            expect(asPlainText("<p>the marketer&#39;s own words</p>")).toBe("the marketer's own words")
        })

        test('runs of blank lines collapse, so the comment does not open with a gap', () => {
            expect(asPlainText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb')
        })
    })

    describe('flattenCommentMarkup', () => {

        test('rewrites the body and says which key it rewrote', () => {
            const { args, flattened } = flattenCommentMarkup('comment-stream_create_comment', {
                objCode: 'OPTASK', objID: '68c1', message: '<p>Converted to a project.</p>'
            })
            expect(flattened).toBe('message')
            expect(args.message).toBe('Converted to a project.')
            // Everything else is untouched - this is not a general arg rewriter.
            expect(args.objCode).toBe('OPTASK')
            expect(args.objID).toBe('68c1')
        })

        test('plain text passes through byte for byte', () => {
            const sent = { message: 'Agent 2 - Review / Triage (automated)\n\nConverted to a project.' }
            const { args, flattened } = flattenCommentMarkup('comment-stream_create_comment', sent)
            expect(flattened).toBeNull()
            expect(args.message).toBe(sent.message)
        })

        test('every Workfront flavour names the body differently, and all are covered', () => {
            expect(flattenCommentMarkup('wf_comments_create', { text: '<p>x</p>' }).flattened).toBe('text')
            expect(flattenCommentMarkup('comment-stream_add_comment', { body: '<p>x</p>' }).flattened).toBe('body')
            expect(flattenCommentMarkup('notes_reply', { note: '<p>x</p>' }).flattened).toBe('note')
        })

        test('leaves other tools alone - markup in a field value may be intended', () => {
            // workflow_update_any_object writes to custom fields, and a rich-text
            // field is entitled to contain HTML. Converting it would be the bug.
            expect(flattenCommentMarkup('workflow_update_any_object', { data: '<p>keep me</p>' }).flattened).toBeNull()
            expect(flattenCommentMarkup('insights_summarize_object', { id: '<p>x</p>' }).flattened).toBeNull()
        })

        test('a body that is nothing but markup is sent unchanged rather than posted blank', () => {
            // Better a visibly odd comment than a silent empty one reported as
            // posted: the assistant would then describe a comment nobody can see.
            const { args, flattened } = flattenCommentMarkup('comment-stream_create_comment', { message: '<hr><br>' })
            expect(flattened).toBeNull()
            expect(args.message).toBe('<hr><br>')
        })

        test('survives the shapes a client can actually send', () => {
            expect(flattenCommentMarkup('comment-stream_create_comment', null).flattened).toBeNull()
            expect(flattenCommentMarkup('comment-stream_create_comment', {}).flattened).toBeNull()
            expect(flattenCommentMarkup(undefined, { message: '<p>x</p>' }).flattened).toBeNull()
            expect(flattenCommentMarkup('comment-stream_create_comment', { message: 42 }).flattened).toBeNull()
        })
    })
})
