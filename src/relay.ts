import 'dotenv/config';
import { redis, prisma } from '.';



const STREAM_NAME = 'video-queue';
const RELAY_INTERVAL = 1000; // steady 1s heartbeat
const BATCH_SIZE = 100;

const tick = async () => {
    const rows = await prisma.outbox.findMany({
        where: { published: false },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
    });
    if (rows.length === 0) return;

    for (const row of rows) {
        await redis.xadd(STREAM_NAME, '*', 'job', row.payload);
        await prisma.outbox.update({
            where: { id: row.id },
            data: { published: true, publishedAt: new Date() },
        });
        console.log(`[RELAY] Published job ${row.jobId}`);
    }
};

const start = () => {
    console.log(`Outbox relay started — polling for unpublished jobs every ${RELAY_INTERVAL}ms`);
    setInterval(() => {
        tick().catch((err) => console.error('[RELAY] tick failed:', err));
    }, RELAY_INTERVAL);
};

start();
