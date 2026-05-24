// gRPC module barrel export
export { JobServiceDef, WorkerServiceDef, grpc, PROTO_PATH } from './loader.js';
export { createServer } from './server.js';
export {
  createJobClient,
  createWorkerClient,
  createJobClientAsync,
  createWorkerClientAsync,
} from './client.js';
