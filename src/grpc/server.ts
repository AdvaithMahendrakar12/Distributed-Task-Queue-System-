import 'dotenv/config';
import { grpc, JobServiceDef, WorkerServiceDef } from './loader.js';
import { redis, prisma } from '../index.js';
import type { ServerUnaryCall, ServerWritableStream, sendUnaryData } from '@grpc/grpc-js';

// ============================================================================
// Type aliases for handler readability
// ============================================================================

type UnaryCall<Req, Res> = ServerUnaryCall<Req, Res>;
type Callback<Res> = sendUnaryData<Res>;

// ============================================================================
// Constants
// ============================================================================

const STREAM_NAME = 'video-queue';
const GROUP_NAME = 'video-workers';

// ============================================================================
// Helpers
// ============================================================================

/** Convert a JS Date to a google.protobuf.Timestamp-compatible object */
const toTimestamp = (date: Date | null | undefined) => {
  if (!date) return null;
  const ms = date.getTime();
  return { seconds: Math.floor(ms / 1000).toString(), nanos: (ms % 1000) * 1e6 };
};

/** Map a Prisma Job row to the proto Job message shape */
const jobToProto = (row: any) => ({
  id: row.id,
  type: row.type,
  payload: row.payload ?? {},
  status: `JOB_STATUS_${(row.status as string).toUpperCase()}`,
  workerId: row.workerId ?? '',
  retryCount: row.retryCount,
  errorMessage: row.errorMessage ?? '',
  createdAt: toTimestamp(row.createdAt),
  startedAt: toTimestamp(row.startedAt),
  completedAt: toTimestamp(row.completedAt),
});

/** Map proto enum string to DB status string */
const protoStatusToDb = (protoStatus: string): string | undefined => {
  const map: Record<string, string> = {
    JOB_STATUS_PENDING: 'pending',
    JOB_STATUS_PROCESSING: 'processing',
    JOB_STATUS_COMPLETED: 'completed',
    JOB_STATUS_FAILED: 'failed',
    JOB_STATUS_CANCELLED: 'cancelled',
  };
  return map[protoStatus];
};

/** Map proto Resolution enum to the TypeScript union value */
const protoResolutionToString = (r: string): '720p' | '1080p' => {
  return r === 'RESOLUTION_1080P' ? '1080p' : '720p';
};

/** Map proto OutputFormat enum to the TypeScript union value */
const protoFormatToString = (f: string): 'mp4' | 'webm' => {
  return f === 'OUTPUT_FORMAT_WEBM' ? 'webm' : 'mp4';
};

// ============================================================================
// JobService Implementation
// ============================================================================

const jobServiceHandlers = {

  /**
   * SubmitJob — Create a DB record, publish to Redis stream, return the job.
   */
  async SubmitJob(
    call: UnaryCall<any, any>,
    callback: Callback<any>,
  ) {
    try {
      const { type, payload } = call.request;
      const id = crypto.randomUUID();
      const now = new Date();

      // Build the payload for Prisma (JSON column)
      const dbPayload = {
        videoId: payload.videoId,
        videoUrl: payload.videoUrl,
        resolution: protoResolutionToString(payload.resolution),
        outputFormat: protoFormatToString(payload.outputFormat),
      };

      // Persist to Postgres
      const dbJob = await prisma.job.create({
        data: {
          id,
          type: type || 'process_video',
          payload: dbPayload,
          status: 'pending',
          retryCount: 0,
          createdAt: now,
        },
      });

      // Publish to Redis Stream
      const jobForStream = {
        id,
        type: dbJob.type,
        payload: dbPayload,
        createdAt: now.toISOString(),
        status: 'pending',
        retryCount: 0,
      };

      const entryId = await redis.xadd(
        STREAM_NAME,
        '*',
        'job', JSON.stringify(jobForStream),
      );

      console.log(`[JobService] SubmitJob: ${id} → stream entry ${entryId}`);

      callback(null, {
        job: jobToProto(dbJob),
        entryId: entryId,
      });
    } catch (err: any) {
      console.error('[JobService] SubmitJob error:', err);
      callback({
        code: grpc.status.INTERNAL,
        message: err.message ?? 'Failed to submit job',
      });
    }
  },

  /**
   * GetJob — Retrieve a single job by ID.
   */
  async GetJob(
    call: UnaryCall<any, any>,
    callback: Callback<any>,
  ) {
    try {
      const { jobId } = call.request;
      const dbJob = await prisma.job.findUnique({ where: { id: jobId } });

      if (!dbJob) {
        return callback({
          code: grpc.status.NOT_FOUND,
          message: `Job ${jobId} not found`,
        });
      }

      callback(null, { job: jobToProto(dbJob) });
    } catch (err: any) {
      callback({
        code: grpc.status.INTERNAL,
        message: err.message ?? 'Failed to get job',
      });
    }
  },

  /**
   * ListJobs — List jobs with optional status filter and cursor pagination.
   */
  async ListJobs(
    call: UnaryCall<any, any>,
    callback: Callback<any>,
  ) {
    try {
      const { status, pageSize, pageToken } = call.request;
      const take = Math.min(Math.max(pageSize || 20, 1), 100);

      // Build filter
      const where: any = {};
      const dbStatus = protoStatusToDb(status);
      if (dbStatus) {
        where.status = dbStatus;
      }

      // Cursor-based pagination using job ID
      const findArgs: any = {
        where,
        take: take + 1, // fetch one extra to detect next page
        orderBy: { createdAt: 'desc' as const },
      };
      if (pageToken) {
        findArgs.cursor = { id: pageToken };
        findArgs.skip = 1; // skip the cursor itself
      }

      const [rows, totalCount] = await Promise.all([
        prisma.job.findMany(findArgs),
        prisma.job.count({ where }),
      ]);

      const hasMore = rows.length > take;
      const jobs = hasMore ? rows.slice(0, take) : rows;
      const nextPageToken = hasMore ? jobs[jobs.length - 1].id : '';

      callback(null, {
        jobs: jobs.map(jobToProto),
        nextPageToken,
        totalCount,
      });
    } catch (err: any) {
      callback({
        code: grpc.status.INTERNAL,
        message: err.message ?? 'Failed to list jobs',
      });
    }
  },

  /**
   * CancelJob — Cancel a pending job. Fails if already processing/completed.
   */
  async CancelJob(
    call: UnaryCall<any, any>,
    callback: Callback<any>,
  ) {
    try {
      const { jobId } = call.request;
      const dbJob = await prisma.job.findUnique({ where: { id: jobId } });

      if (!dbJob) {
        return callback({
          code: grpc.status.NOT_FOUND,
          message: `Job ${jobId} not found`,
        });
      }

      if (dbJob.status !== 'pending') {
        return callback({
          code: grpc.status.FAILED_PRECONDITION,
          message: `Cannot cancel job in '${dbJob.status}' state — only 'pending' jobs can be cancelled`,
        });
      }

      const updated = await prisma.job.update({
        where: { id: jobId },
        data: { status: 'cancelled' },
      });

      console.log(`[JobService] CancelJob: ${jobId} → cancelled`);
      callback(null, { job: jobToProto(updated) });
    } catch (err: any) {
      callback({
        code: grpc.status.INTERNAL,
        message: err.message ?? 'Failed to cancel job',
      });
    }
  },
};

// ============================================================================
// WorkerService Implementation
// ============================================================================

// Track registered workers for heartbeat monitoring
const registeredWorkers = new Map<string, {
  name: string;
  labels: Record<string, string>;
  lastHeartbeat: number;
  activeStreams: Set<ServerWritableStream<any, any>>;
}>();

// Periodically check for dead workers and reclaim their jobs
const HEARTBEAT_TIMEOUT_MS = 30_000;

setInterval(() => {
  const now = Date.now();
  for (const [workerId, info] of registeredWorkers) {
    if (now - info.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      console.log(`[WorkerService] Worker ${workerId} (${info.name}) timed out — closing streams`);
      for (const stream of info.activeStreams) {
        stream.end();
      }
      registeredWorkers.delete(workerId);
    }
  }
}, 10_000);

const workerServiceHandlers = {

  /**
   * RegisterWorker — Assign a unique ID and return consumer group config.
   */
  async RegisterWorker(
    call: UnaryCall<any, any>,
    callback: Callback<any>,
  ) {
    try {
      const { workerName, labels } = call.request;
      const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;

      // Ensure the consumer group exists
      try {
        await redis.xgroup('CREATE', STREAM_NAME, GROUP_NAME, '0', 'MKSTREAM');
      } catch {
        // Group already exists — fine
      }

      registeredWorkers.set(workerId, {
        name: workerName || workerId,
        labels: labels || {},
        lastHeartbeat: Date.now(),
        activeStreams: new Set(),
      });

      console.log(`[WorkerService] RegisterWorker: ${workerId} (${workerName})`);

      callback(null, {
        workerId,
        consumerGroup: GROUP_NAME,
        streamName: STREAM_NAME,
      });
    } catch (err: any) {
      callback({
        code: grpc.status.INTERNAL,
        message: err.message ?? 'Failed to register worker',
      });
    }
  },

  /**
   * StreamJobs — Server-streaming RPC.
   * Opens a long-lived stream and pushes job assignments as they arrive
   * from Redis via XREADGROUP. Replaces the worker's polling loop.
   */
  async StreamJobs(
    call: ServerWritableStream<any, any>,
  ) {
    const { workerId } = call.request;
    const workerInfo = registeredWorkers.get(workerId);

    if (!workerInfo) {
      call.destroy(new Error(`Worker ${workerId} not registered — call RegisterWorker first`));
      return;
    }

    workerInfo.activeStreams.add(call);
    console.log(`[WorkerService] StreamJobs: streaming started for ${workerId}`);

    let running = true;

    call.on('cancelled', () => {
      running = false;
      workerInfo.activeStreams.delete(call);
      console.log(`[WorkerService] StreamJobs: ${workerId} stream cancelled`);
    });

    call.on('error', () => {
      running = false;
      workerInfo.activeStreams.delete(call);
    });

    // Continuously read from Redis stream and push to the gRPC stream
    while (running) {
      try {
        const messages = await redis.xreadgroup(
          'GROUP',
          GROUP_NAME,
          workerId,
          'COUNT', 1,
          'BLOCK', 5000, // block 5s then re-check if stream is still alive
          'STREAMS',
          STREAM_NAME,
          '>',
        );

        if (!messages || !Array.isArray(messages)) continue;

        for (const [, entries] of messages as [string, [string, string[]][]][]) {
          for (const [messageId, fields] of entries) {
            const job = JSON.parse(fields[1]);

            // Update DB to processing
            try {
              await prisma.job.update({
                where: { id: job.id },
                data: {
                  status: 'processing',
                  workerId,
                  startedAt: new Date(),
                },
              });
            } catch {
              // Job might not exist in DB (e.g. stale message) — still send it
            }

            const assignment = {
              streamEntryId: messageId,
              job: jobToProto({
                ...job,
                status: 'processing',
                workerId,
                retryCount: job.retryCount ?? 0,
                createdAt: new Date(job.createdAt),
                startedAt: new Date(),
                completedAt: null,
              }),
            };

            call.write(assignment);
            console.log(`[WorkerService] StreamJobs: pushed job ${job.id} → ${workerId}`);
          }
        }
      } catch (err) {
        if (running) {
          console.error(`[WorkerService] StreamJobs error for ${workerId}:`, err);
          await new Promise(r => setTimeout(r, 1000)); // backoff on error
        }
      }
    }
  },

  /**
   * Heartbeat — Worker proves liveness, server responds with config.
   */
  async Heartbeat(
    call: UnaryCall<any, any>,
    callback: Callback<any>,
  ) {
    const { workerId, activeJobCount } = call.request;
    const workerInfo = registeredWorkers.get(workerId);

    if (!workerInfo) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Worker ${workerId} not registered`,
      });
    }

    workerInfo.lastHeartbeat = Date.now();
    console.log(`[WorkerService] Heartbeat: ${workerId} (${activeJobCount} active jobs)`);

    callback(null, {
      acknowledged: true,
      heartbeatIntervalMs: '10000',
    });
  },

  /**
   * ReportJobResult — Worker reports success or failure for a job.
   */
  async ReportJobResult(
    call: UnaryCall<any, any>,
    callback: Callback<any>,
  ) {
    try {
      const { workerId, jobId, streamEntryId, success, failure } = call.request;

      // XACK the message in Redis
      await redis.xack(STREAM_NAME, GROUP_NAME, streamEntryId);

      let updated;

      if (success) {
        updated = await prisma.job.update({
          where: { id: jobId },
          data: {
            status: 'completed',
            completedAt: new Date(),
          },
        });
        console.log(`[WorkerService] ReportJobResult: ${jobId} → completed (by ${workerId})`);
      } else if (failure) {
        updated = await prisma.job.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            errorMessage: failure.errorMessage ?? 'Unknown error',
            retryCount: { increment: 1 },
          },
        });
        console.log(`[WorkerService] ReportJobResult: ${jobId} → failed (by ${workerId})`);

        // If the failure is retryable, re-enqueue the job
        if (failure.retryable) {
          const retried = await prisma.job.findUnique({ where: { id: jobId } });
          if (retried && retried.retryCount < 3) {
            const retryPayload = {
              id: jobId,
              type: retried.type,
              payload: retried.payload,
              createdAt: retried.createdAt.toISOString(),
              status: 'pending',
              retryCount: retried.retryCount,
            };
            await redis.xadd(STREAM_NAME, '*', 'job', JSON.stringify(retryPayload));
            await prisma.job.update({
              where: { id: jobId },
              data: { status: 'pending' },
            });
            console.log(`[WorkerService] ReportJobResult: ${jobId} → re-enqueued (retry ${retried.retryCount}/3)`);
          }
        }
      }

      callback(null, { job: updated ? jobToProto(updated) : null });
    } catch (err: any) {
      callback({
        code: grpc.status.INTERNAL,
        message: err.message ?? 'Failed to report job result',
      });
    }
  },

  /**
   * DeregisterWorker — Graceful shutdown. Close streams, clean up tracking.
   */
  async DeregisterWorker(
    call: UnaryCall<any, any>,
    callback: Callback<any>,
  ) {
    const { workerId } = call.request;
    const workerInfo = registeredWorkers.get(workerId);

    if (workerInfo) {
      for (const stream of workerInfo.activeStreams) {
        stream.end();
      }
      registeredWorkers.delete(workerId);
      console.log(`[WorkerService] DeregisterWorker: ${workerId}`);
    }

    callback(null, {});
  },
};

// ============================================================================
// Server Bootstrap
// ============================================================================

export function createServer(): grpc.Server {
  const server = new grpc.Server();

  server.addService(JobServiceDef.service, jobServiceHandlers);
  server.addService(WorkerServiceDef.service, workerServiceHandlers);

  return server;
}

export { jobServiceHandlers, workerServiceHandlers };
