import { closeDbPool } from "../db/index.js";
import {
  claimNextJobWithProviderLease,
  countAvailableProviderPoolSlots,
  enabledProviderPoolsForQueues,
  priorityQueuesForProviderPool,
  runQueueWorkerOnce,
  unpooledQueues,
} from "../modules/queue/core/index.js";
import { ensureRuntimeSettingsLoaded } from "../modules/settings/settings.service.js";

type QueueName =
  | "findingCandidate"
  | "episodeDistiller"
  | "coveringEvidence"
  | "deadZoneMergeReview"
  | "landscapeCuration"
  | "finalizeDistille"
  | "mergeActivationFinalize";

type CliOptions = {
  queue: QueueName;
  once: boolean;
  limit: number;
  worker?: string;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    queue: "findingCandidate",
    once: false,
    limit: 1,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--queue" || arg.startsWith("--queue=")) {
      const inline = arg.match(/^--queue=(.*)$/)?.[1];
      const raw =
        inline !== undefined
          ? inline.trim()
          : (() => {
              const next = args[index + 1];
              if (!next || next.startsWith("--")) throw new Error("--queue requires a value");
              index += 1;
              return next.trim();
            })();
      if (
        raw !== "findingCandidate" &&
        raw !== "episodeDistiller" &&
        raw !== "coveringEvidence" &&
        raw !== "deadZoneMergeReview" &&
        raw !== "landscapeCuration" &&
        raw !== "finalizeDistille" &&
        raw !== "mergeActivationFinalize"
      ) {
        throw new Error(
          "--queue must be findingCandidate|episodeDistiller|coveringEvidence|deadZoneMergeReview|landscapeCuration|finalizeDistille|mergeActivationFinalize",
        );
      }
      options.queue = raw;
    } else if (arg === "--once") {
      options.once = true;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const inline = arg.match(/^--limit=(.*)$/)?.[1];
      const raw =
        inline !== undefined
          ? inline
          : (() => {
              const next = args[index + 1];
              if (!next || next.startsWith("--")) throw new Error("--limit requires a value");
              index += 1;
              return next;
            })();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--limit must be >=1");
      options.limit = parsed;
    } else if (arg === "--worker" || arg.startsWith("--worker=")) {
      const inline = arg.match(/^--worker=(.*)$/)?.[1];
      if (inline !== undefined) {
        options.worker = inline.trim();
      } else {
        const next = args[index + 1];
        if (!next || next.startsWith("--")) throw new Error("--worker requires a value");
        options.worker = next.trim();
        index += 1;
      }
    } else if (arg === "--json") {
      // json-only output
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.once) {
    throw new Error("--once is required");
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await ensureRuntimeSettingsLoaded();
  const workerBase = options.worker?.trim() || `queue:${options.queue}`;
  const runTasks: Array<ReturnType<typeof runQueueWorkerOnce>> = [];
  const pools = enabledProviderPoolsForQueues([options.queue]);
  for (const pool of pools) {
    const freeSlots = await countAvailableProviderPoolSlots(pool);
    for (let index = 0; index < Math.min(options.limit, freeSlots); index += 1) {
      const assignment = await claimNextJobWithProviderLease({
        pool,
        priorityQueues: priorityQueuesForProviderPool({
          poolId: pool.id,
          allowedQueues: [options.queue],
        }),
        workerId: `${workerBase}:${pool.id}:${index + 1}`,
      });
      if (!assignment) break;
      runTasks.push(
        runQueueWorkerOnce({
          queueName: assignment.queueName,
          workerId: `${workerBase}:${pool.id}:${index + 1}`,
          claimedJob: { id: assignment.id },
          providerLease: assignment.providerLease,
        }),
      );
    }
  }
  runTasks.push(
    ...unpooledQueues([options.queue]).flatMap((queueName) =>
      Array.from({ length: options.limit }, (_, index) =>
        runQueueWorkerOnce({
          queueName,
          workerId: `${workerBase}:${index + 1}`,
        }),
      ),
    ),
  );
  const runs = await Promise.all(runTasks);
  const processed = runs.filter((run) => !run.idle).length;
  const failed = runs.filter((run) => !run.ok).length;
  const result = {
    ok: failed === 0,
    queue: options.queue,
    worker: workerBase,
    idle: processed === 0,
    processed,
    failed,
    runs,
  } as const;
  process.stdout.write(
    `${JSON.stringify(
      {
        limit: options.limit,
        ...result,
      },
      null,
      2,
    )}\n`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
