import 'dotenv/config';
import { redis } from '.';
import { VideoJob } from './types';


const STREAM_NAME = 'video-queue';
const RETRY_ZSET = 'video-retry';
const POLL_INTERVAL = 1000; // steady 1s heartbeat

const tick = async () => {
    const now = Date.now();

    const due = await redis.zrangebyscore(RETRY_ZSET, 0, now);
    if (due.length === 0) return;

    for (const member of due) {

        await redis.xadd(STREAM_NAME, '*', 'job', member);
        await redis.zrem(RETRY_ZSET, member);

        const job = JSON.parse(member) as VideoJob;
        console.log(`[SCHEDULER] Re-enqueued job ${job.id}`);
    }
};

const start = () => {
    console.log(`Retry scheduler started - polling '${RETRY_ZSET}' every ${POLL_INTERVAL}ms`);
    setInterval(() => {
        tick().catch((err) => console.error('[SCHEDULER] tick failed:', err));
    }, POLL_INTERVAL);
};

start();
