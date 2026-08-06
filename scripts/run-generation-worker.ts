/**
 * Sprint 2H Part 2B: standalone worker process topology.
 *
 * Wires the exact same `GenerationWorkerCapability` +
 * `GenerationSchedulerCapability` the protected worker endpoint uses — no
 * HTTP layer, no customer request involved anywhere in the loop. Intended
 * to run as its own long-lived process (e.g. a DigitalOcean "Worker"
 * component deployed alongside the web service), or locally in a second
 * terminal during development so generation completes without needing to
 * curl the worker endpoint by hand.
 *
 * Usage:
 *   npm run worker
 *
 * Stop with Ctrl+C (SIGINT) or SIGTERM — both stop the scheduler cleanly
 * (no timer left running) rather than killing the process mid-job. A job
 * already claimed and in flight when a signal arrives is not interrupted;
 * this process simply stops claiming new ones and exits once idle.
 */
import { getCapabilityGraph } from "@/capabilities/composition";

function main(): void {
  const { workerScheduler } = getCapabilityGraph();

  console.log("[worker] starting generation worker (standalone process)");
  workerScheduler.start();

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] received ${signal} — stopping scheduler`);
    workerScheduler.stop();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
