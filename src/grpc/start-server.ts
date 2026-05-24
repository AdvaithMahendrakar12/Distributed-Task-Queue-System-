import 'dotenv/config';
import { grpc } from './loader.js';
import { createServer } from './server.js';

const PORT = process.env.GRPC_PORT || '50051';
const BIND_ADDRESS = `0.0.0.0:${PORT}`;

async function main() {
  const server = createServer();

  server.bindAsync(
    BIND_ADDRESS,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('Failed to bind gRPC server:', err);
        process.exit(1);
      }

      console.log(`\n╔════════════════════════════════════════════╗`);
      console.log(`║  gRPC Server listening on port ${port}       ║`);
      console.log(`║                                            ║`);
      console.log(`║  Services:                                 ║`);
      console.log(`║    • JobService    (Submit, Get, List, Cancel)  ║`);
      console.log(`║    • WorkerService (Register, Stream, Report)  ║`);
      console.log(`╚════════════════════════════════════════════╝\n`);
    },
  );

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down gRPC server...');
    server.tryShutdown((err) => {
      if (err) console.error('Error during shutdown:', err);
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error starting gRPC server:', err);
  process.exit(1);
});
