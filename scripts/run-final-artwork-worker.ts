/**
 * Sprint 2M Phase 2C: standalone final-artwork worker process topology —
 * mirrors `scripts/run-generation-worker.ts` exactly, targeting
 * `finalArtworkScheduler` instead of `workerScheduler`. A separate process
 * (not folded into the generation worker) so the two job queues can be
 * observed, scaled, and restarted independently (Goal 21).
 *
 * Usage:
 *   npm run worker:final-artwork
 *
 * Stop with Ctrl+C (SIGINT) or SIGTERM.
 */
import { getCapabilityGraph } from "@/capabilities/composition";

function main(): void {
  const { finalArtworkScheduler } = getCapabilityGraph();

  console.log("[worker] starting final-artwork worker (standalone process)");
  finalArtworkScheduler.start();

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal} — stopping scheduler`);
    finalArtworkScheduler.stop();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
