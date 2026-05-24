import path from 'path';
import { fileURLToPath } from 'url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

// Resolve __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the .proto file
const PROTO_PATH = path.resolve(__dirname, '..', 'proto', 'job.proto');

// Load the proto file with full type information
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,       // convert snake_case → camelCase
  longs: String,         // represent int64 as strings (safe for JS)
  enums: String,         // represent enums as their string name
  defaults: true,        // include default values in deserialized messages
  oneofs: true,          // include virtual oneof fields
});

// Load gRPC package definition
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);

// Extract the taskqueue package
// The proto defines `package taskqueue;` so all services/messages live here
const taskqueuePackage = protoDescriptor.taskqueue as any;

// Export individual service constructors for use in server and client
export const JobServiceDef = taskqueuePackage.JobService;
export const WorkerServiceDef = taskqueuePackage.WorkerService;

export { grpc, PROTO_PATH, packageDefinition, taskqueuePackage };
