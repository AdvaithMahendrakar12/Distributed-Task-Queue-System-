import 'dotenv/config';
import { VideoJob } from './types';
import { redis } from '.';



//create a group of workers
//least busiest one gets the job assigned 

const STREAM_NAME = 'video-queue';
const GROUP_NAME = 'video-workers';
const CONSUMER_NAME = `worker-${process.pid}`

const createWorkerGroup = async () => {
    try {
        await redis.xgroup('CREATE', STREAM_NAME, GROUP_NAME, '0', 'MKSTREAM');
        console.log(`Worker group ${GROUP_NAME} created`);
    } catch (error) {
        console.log(error);
    }
}

const processJob = async (job: VideoJob) => {
    if (job.payload.resolution === '720p') {
        setTimeout(() => {
            console.log(`Processing job ${job.id}`);
        }, 5000);
    }
    if (job.payload.resolution === '1080p') {
        setTimeout(() => {
            console.log(`Processing job ${job.id}`);
        }, 10000);
    }
}


const startWorker = async () => {
    await createWorkerGroup();
    console.log(`Worker ${CONSUMER_NAME} started`);
    while (true) {
        const messages = await redis.xreadgroup(
            'GROUP',
            GROUP_NAME,
            CONSUMER_NAME,
            'COUNT', // read only 1 message at a time
            1, //number of messages to read
            'BLOCK',
            0, //block for 0 seconds
            'STREAMS',
            STREAM_NAME,
            '>' //read from the last unread message
        );
        if (!messages || !Array.isArray(messages)) continue;
        for (const [key, message] of messages as [string, [string, string[]][]][]) {
            const [messageId, fields] = message[0];
            const job = JSON.parse(fields[1]) as VideoJob;
            processJob(job);
        }
    }
}

startWorker();