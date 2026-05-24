import { grpc, JobServiceDef, WorkerServiceDef } from './loader.js';

// ============================================================================
// Client Factory
// ============================================================================

const GRPC_TARGET = process.env.GRPC_TARGET || 'localhost:50051';

/**
 * Create a typed gRPC client for the JobService.
 *
 * Usage:
 *   const client = createJobClient();
 *   client.submitJob({ type: 'process_video', payload: { ... } }, (err, res) => { ... });
 */
export function createJobClient() {
  return new JobServiceDef(
    GRPC_TARGET,
    grpc.credentials.createInsecure(),
  );
}

/**
 * Create a typed gRPC client for the WorkerService.
 *
 * Usage:
 *   const client = createWorkerClient();
 *   client.registerWorker({ workerName: 'my-worker' }, (err, res) => { ... });
 *   const stream = client.streamJobs({ workerId: res.workerId });
 *   stream.on('data', (assignment) => { ... });
 */
export function createWorkerClient() {
  return new WorkerServiceDef(
    GRPC_TARGET,
    grpc.credentials.createInsecure(),
  );
}

// ============================================================================
// Promisified helpers — wrap callback-style gRPC calls in Promises
// ============================================================================

/** Wrap a unary gRPC call in a Promise */
function promisify<Req, Res>(client: any, method: string) {
  return (request: Req): Promise<Res> =>
    new Promise((resolve, reject) => {
      client[method](request, (err: any, response: Res) => {
        if (err) reject(err);
        else resolve(response);
      });
    });
}

/**
 * Promise-based JobService client.
 *
 * Usage:
 *   const jobs = createJobClientAsync();
 *   const { job, entryId } = await jobs.submitJob({ type: 'process_video', payload: { ... } });
 */
export function createJobClientAsync() {
  const client = createJobClient();

  return {
    submitJob: promisify<any, any>(client, 'submitJob'),
    getJob: promisify<any, any>(client, 'getJob'),
    listJobs: promisify<any, any>(client, 'listJobs'),
    cancelJob: promisify<any, any>(client, 'cancelJob'),
    close: () => client.close(),
  };
}

/**
 * Promise-based WorkerService client (unary RPCs only).
 * For StreamJobs, use createWorkerClient() directly and call .streamJobs().
 *
 * Usage:
 *   const worker = createWorkerClientAsync();
 *   const { workerId } = await worker.registerWorker({ workerName: 'w1' });
 */
export function createWorkerClientAsync() {
  const client = createWorkerClient();

  return {
    registerWorker: promisify<any, any>(client, 'registerWorker'),
    heartbeat: promisify<any, any>(client, 'heartbeat'),
    reportJobResult: promisify<any, any>(client, 'reportJobResult'),
    deregisterWorker: promisify<any, any>(client, 'deregisterWorker'),
    /** Raw client for server-streaming StreamJobs RPC */
    streamJobs: (request: any) => client.streamJobs(request),
    close: () => client.close(),
  };
}
