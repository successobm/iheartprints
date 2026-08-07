/**
 * Release-blocker hotfix: preloaded via `node --import` BEFORE any test
 * file (see `package.json`'s `test` script), guaranteeing every automated
 * test process carries the safety signal
 * `lib/config/automated-test-safety.ts` checks — no test file, no
 * developer action, and no `.env.local`/ambient-shell content can omit it.
 * See that module's doc comment for the full incident this closes.
 *
 * Deliberately synchronous, side-effect-only, and the very first thing this
 * process does once the `tsx` loader itself has registered (it must be
 * imported after `--import tsx` on the command line so this `.ts` file
 * itself can be loaded).
 *
 * This file intentionally does nothing else — it must never grow
 * additional test-bootstrap responsibilities. If more shared test setup is
 * ever needed, add a new, separately-named `--import` preload rather than
 * overloading this one.
 */
process.env.IHEARTPRINTS_AUTOMATED_TEST = "1";

export {};
