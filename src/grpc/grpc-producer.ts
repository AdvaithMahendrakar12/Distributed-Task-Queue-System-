import 'dotenv/config';
import { createJobClientAsync } from './client.js';

/**
 * Example gRPC producer — submits a job via the JobService gRPC API.
 *
 * Run: npm run grpc:submit
 */

async function main() {
  const client = createJobClientAsync();

  console.log('📤 Submitting video processing job via gRPC...\n');

  // ── Submit a job ──────────────────────────────────────────────────────
  const submitResult = await client.submitJob({
    type: 'process_video',
    payload: {
      videoId: 'vid_grpc_001',
      videoUrl: 'https://example.com/video.mp4',
      resolution: 'RESOLUTION_1080P',
      outputFormat: 'OUTPUT_FORMAT_MP4',
    },
  });

  console.log('✅ Job submitted:');
  console.log(`   ID:       ${submitResult.job.id}`);
  console.log(`   Status:   ${submitResult.job.status}`);
  console.log(`   Entry ID: ${submitResult.entryId}\n`);

  // ── Query the job back ────────────────────────────────────────────────
  const getResult = await client.getJob({ jobId: submitResult.job.id });
  console.log('🔍 Retrieved job:');
  console.log(`   Status: ${getResult.job.status}`);
  console.log(`   Type:   ${getResult.job.type}\n`);

  // ── List all pending jobs ─────────────────────────────────────────────
  const listResult = await client.listJobs({
    status: 'JOB_STATUS_PENDING',
    pageSize: 10,
  });
  console.log(`📋 Pending jobs: ${listResult.totalCount}`);
  for (const job of listResult.jobs) {
    console.log(`   • ${job.id} (${job.status})`);
  }

  client.close();
  console.log('\n✅ Done');
}

main().catch((err) => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
