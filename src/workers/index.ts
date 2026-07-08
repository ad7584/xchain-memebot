/**
 * Worker orchestrator. Runs the recurring jobs as self-scheduling loops (next run
 * is scheduled only after the previous finishes, so slow ticks never overlap).
 * Can run in-process with the bot (RUN_WORKERS_IN_PROCESS=true) or as a separate
 * process (`npm run worker` → worker.ts).
 */
import { logger } from "../logger.js";
import { isShuttingDown } from "../shutdown.js";
import { processWithdrawals } from "./withdrawals.js";
import { recoverOrders } from "./recovery.js";
import { scanDeposits } from "./deposits.js";
import { refillGasTank } from "./gasRefill.js";
import type { WorkerDeps } from "./types.js";

interface Job {
  name: string;
  intervalMs: number;
  run: (deps: WorkerDeps) => Promise<void>;
}

const JOBS: Job[] = [
  { name: "withdrawals", intervalMs: 30_000, run: processWithdrawals },
  { name: "recovery", intervalMs: 45_000, run: recoverOrders },
  { name: "deposits", intervalMs: 60_000, run: scanDeposits },
  { name: "gasRefill", intervalMs: 120_000, run: () => refillGasTank() },
];

export function startWorkers(deps: WorkerDeps): { stop: () => void } {
  const stops: Array<() => void> = [];
  for (const job of JOBS) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped || isShuttingDown()) return;
      const t0 = Date.now();
      try {
        await job.run(deps);
      } catch (err) {
        logger.error({ err, job: job.name }, "worker tick error");
      }
      logger.debug({ job: job.name, ms: Date.now() - t0 }, "worker tick");
      if (!stopped) timer = setTimeout(tick, job.intervalMs);
    };
    timer = setTimeout(tick, 3_000); // small startup delay
    stops.push(() => {
      stopped = true;
      clearTimeout(timer);
    });
  }
  logger.info(`workers started: ${JOBS.map((j) => j.name).join(", ")}`);
  return { stop: () => stops.forEach((s) => s()) };
}
