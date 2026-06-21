import 'dotenv/config';
import { VideoJob } from './types';
import { redis } from '.';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

// Initialize gRPC Client
const packageDef = protoLoader.loadSync('./src/proto/job.proto');
const grpcObject = grpc.loadPackageDefinition(packageDef);
const taskqueue = (grpcObject as any).taskqueue;

const client = new taskqueue.JobService(
    'localhost:50051',
    grpc.credentials.createInsecure()
);



//create a group of workers
//least busiest one gets the job assigned 

const STREAM_NAME = 'video-queue';
const GROUP_NAME = 'video-workers';
const CONSUMER_NAME = `worker-${process.pid}`
const CLAIM_IDLE_TIME = 30000; // reclaim jobs idle for 30 seconds
const createWorkerGroup = async () => {
    try {
        await redis.xgroup('CREATE', STREAM_NAME, GROUP_NAME, '0', 'MKSTREAM'); //MKSTREAM is used to create the stream if it doesn't exist
        console.log(`Worker group ${GROUP_NAME} created`);
    } catch (error) {
        // Group already exists — that's fine   
    }
}

const processJob = async (job: VideoJob) => {
    if (job.payload.resolution === '720p') {
        console.log(`Processing job ${job.id} (720p - 5s)`);
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (job.payload.resolution === '1080p') {
        console.log(`Processing job ${job.id} (1080p - 10s)`);
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
}

const reportResult = (req: { jobId: string; status: string; errorMessage: string }): Promise<any> =>
    new Promise((resolve, reject) => {
        client.reportJobResult(req, (err: any, res: any) => {
            if (err) reject(err);
            else resolve(res);
        });
    });

const handleJob = async (messageId: string, job: VideoJob) => {
    try {
        await reportResult({ jobId: job.id, status: 'processing', errorMessage: '' });
        console.log(`Job ${job.id} status updated to processing`);

        await processJob(job);

        await redis.xack(STREAM_NAME, GROUP_NAME, messageId);

        // Best-effort after ack — don't let a report failure cascade into the failure path
        reportResult({ jobId: job.id, status: 'completed', errorMessage: '' })
            .then(() => console.log(`Job ${job.id} completed`))
            .catch((err) => console.error(`Job ${job.id}: failed to report completed`, err));

    } catch (error) {
        console.error(`Job ${job.id} failed:`, error);

        try {
            const response = await reportResult({
                jobId: job.id,
                status: 'failed',
                errorMessage: error instanceof Error ? error.message : 'Unknown error'
            });

            if (response.status === 'dead') {
                await redis.xack(STREAM_NAME, GROUP_NAME, messageId);
                console.log(`Job ${job.id} dead — removed from PEL`);
            } else {
                console.log(`Job ${job.id} failed, leaving in PEL for reclaim`);
            }
        } catch (reportError) {
            console.error(`Job ${job.id}: could not report failure, leaving in PEL`, reportError);
        }
    }
}

// Reclaim stuck jobs from dead workers using XAUTOCLAIM
const reclaimStuckJobs = async () => {
    try {
        const result = await redis.xautoclaim(
            STREAM_NAME,
            GROUP_NAME,
            CONSUMER_NAME,
            CLAIM_IDLE_TIME,  // min idle time in ms
            '0-0',            // start scanning from the beginning
            'COUNT', 10
        );

        // result = [nextStartId, [[messageId, fields], ...], deletedIds]
        const claimed = result[1] as [string, string[]][];
        if (claimed && claimed.length > 0) {
            console.log(`[RECLAIM] Claimed ${claimed.length} stuck job(s)`);
            for (const [messageId, fields] of claimed) {
                const job = JSON.parse(fields[1]) as VideoJob;
                console.log(`[RECLAIM] Re-processing job ${job.id}`);
                await handleJob(messageId, job);
            }
        }
    } catch (error) {
        // XAUTOCLAIM not supported or stream doesn't exist yet — skip
    }
}

const startWorker = async () => {
    await createWorkerGroup();
    console.log(`Worker ${CONSUMER_NAME} started`);
    console.log(`Listening for jobs on '${STREAM_NAME}'...\n`);

    // Periodically check for stuck jobs every 10 seconds
    const reclaimInterval = setInterval(reclaimStuckJobs, 10000);

    while (true) {
        const messages = await redis.xreadgroup(
            'GROUP',
            GROUP_NAME,
            CONSUMER_NAME,
            'COUNT', 1,
            'BLOCK', 5000,  // block for 5s then loop (allows reclaim checks)
            'STREAMS',
            STREAM_NAME,
            '>'
        );
        if (!messages || !Array.isArray(messages)) continue;
        for (const [key, message] of messages as [string, [string, string[]][]][]) {
            const [messageId, fields] = message[0];
            const job = JSON.parse(fields[1]) as VideoJob;
            console.log(`\n[NEW] Picked up job ${job.id}`);
            await handleJob(messageId, job);
        }
    }
}

startWorker();
