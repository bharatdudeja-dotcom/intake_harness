/**
 * One kill switch for every Workfront WRITE the pipeline makes.
 *
 * WHY: the Workfront write tools (issue create, custom-field set, comment post)
 * are not usable in some environments - they 404 / error at the gateway - and
 * that was blocking end-to-end test runs even though the write is meant to be
 * best-effort. Rather than comment out call sites (easy to leave half-reverted)
 * this gives one env flag that short-circuits ALL of them to a clean no-op, so
 * the pipeline flow can be exercised without the broken tools in the way.
 *
 *   WORKFRONT_WRITES_DISABLED=true
 *
 * Default (unset/anything else) keeps the normal behaviour: writes are
 * attempted and, on a tenant where they're off, reported as honest dry-runs.
 * When disabled here, the app doesn't even attempt them - it reports a skipped
 * outcome that reads clearly in the trace, and the idempotency lookups that
 * exist only to guard those writes are skipped too (nothing to double-post).
 *
 * READS ONLY are unaffected - AEP schema probes, segment search, PQL grounding,
 * knowledge search all still run. This flag is strictly about Workfront writes.
 */
export function workfrontWritesDisabled(): boolean {
  return String(process.env.WORKFRONT_WRITES_DISABLED || "").trim().toLowerCase() === "true";
}
