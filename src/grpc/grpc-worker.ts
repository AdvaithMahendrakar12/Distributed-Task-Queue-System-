import 'dotenv/config';
import { createWorkerClientAsync } from './client.js';

/**
 * Example gRPC worker — demonstrates the full worker lifecycle:
 *   1. Register with the server
 *   2. Open a server-streaming connection to receive job assignments
 *   3. Process each job (simulate work)
 *   4. Report success/failure back to the server
 *   5. Send periodic heartbeats
 *
 * Run: npm run grpc:worker
 */

async function main() {
  const client = createWorkerClientAsync();

  // ── Step 1: Register ──────────────────────────────────────────────────
  const { workerId, consumerGroup, streamName } = await client.registerWorker({
    workerName: `grpc-worker-${process.pid}`,
    labels: { hostname: 'localhost', region: 'local' },
  });

  console.log(`\n✅ Registered as ${workerId}`);
  console.log(`   Consumer group: ${consumerGroup}`);
  console.log(`   Stream: ${streamName}\n`);

  // ── Step 2: Heartbeat loop ────────────────────────────────────────────
  let activeJobCount = 0;

  const heartbeatInterval = setInterval(async () => {
    try {
      const resp = await client.heartbeat({ workerId, activeJobCount });
      if (resp.acknowledged) {
        console.log(`💓 Heartbeat acknowledged (interval: ${resp.heartbeatIntervalMs}ms)`);
      }
    } catch (err: any) {
      console.error('Heartbeat failed:', err.message);
    }
  }, 10_000);

  // ── Step 3: Stream jobs ───────────────────────────────────────────────
  const stream = client.streamJobs({ workerId, maxInFlight: 1 });

  stream.on('data', async (assignment: any) => {
    const { streamEntryId, job } = assignment;
    activeJobCount++;

    console.log(`\n📥 Received job ${job.id}`);
    console.log(`   Type: ${job.type}`);
    console.log(`   Resolution: ${job.payload?.resolution}`);
    console.log(`   Format: ${job.payload?.outputFormat}`);

    // Simulate processing
    const duration = job.payload?.resolution === 'RESOLUTION_1080P' ? 10_000 : 5_000;
    console.log(`   ⏳ Processing (${duration / 1000}s)...`);
    await new Promise(r => setTimeout(r, duration));

    // Report success
    try {
      const result = await client.reportJobResult({
        workerId,
        jobId: job.id,
        streamEntryId,
        success: {
          outputUrl: `https://cdn.example.com/output/${job.id}.mp4`,
          metadata: { processedBy: workerId, duration: `${duration}ms` },
        },
      });
      console.log(`   ✅ Job ${job.id} completed → status: ${result.job?.status}`);
    } catch (err: any) {
      console.error(`   ❌ Failed to report result for ${job.id}:`, err.message);
    }

    activeJobCount--;
  });

  stream.on('error', (err: any) => {
    if (err.code === 1) {
      // CANCELLED — normal shutdown
      console.log('Stream cancelled (shutting down)');
    } else {
      console.error('Stream error:', err.message);
    }
  });

  stream.on('end', () => {
    console.log('Stream ended');
    clearInterval(heartbeatInterval);
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────
  const shutdown = async () => {
    console.log('\n🛑 Shutting down worker...');
    stream.cancel();
    clearInterval(heartbeatInterval);

    try {
      await client.deregisterWorker({ workerId });
      console.log('Deregistered from server');
    } catch {
      // Server might already be down
    }

    client.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('🎧 Listening for job assignments...\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
