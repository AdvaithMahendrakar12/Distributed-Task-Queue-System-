import 'dotenv/config';
import express from 'express';
import { redis, prisma } from '.';
import { VideoJob } from './types';


const STREAM_NAME = 'video-queue';
const DLQ_NAME = 'video-dlq';

const app = express();
app.use(express.json());


app.get('/dlq', async (_req, res) => {
    const raw = await redis.lrange(DLQ_NAME, 0, -1);
    const jobs = raw.map((entry) => JSON.parse(entry));
    res.json({ count: jobs.length, jobs });
});

// 2. REDRIVE — operator decided the cause is fixed; send the job back for
//    another attempt with a clean slate.
app.post('/dlq/:id/redrive', async (req, res) => {
    const { id } = req.params;

    // Find the exact stored string so we can remove precisely that entry later.
    const raw = await redis.lrange(DLQ_NAME, 0, -1);
    const entryStr = raw.find((e) => JSON.parse(e).id === id);
    if (!entryStr) {
        return res.status(404).json({ error: `Job ${id} not found in DLQ` });
    }

    const job = JSON.parse(entryStr) as VideoJob;

  //giving it a clean slate by resetting retryCount and errorMessage, and setting status to pending
    await prisma.job.update({
        where: { id },
        data: { status: 'pending', retryCount: 0, errorMessage: null },
    });

    const freshJob: VideoJob = { ...job, status: 'pending', retryCount: 0, errorMessage: undefined };

    // Add to the main queue FIRST, then remove from the DLQ. If we crash
    // between the two the job is re-queued (safe) rather than lost. The cost is
    // a possible duplicate DLQ entry, which is the lesser evil.
    await redis.xadd(STREAM_NAME, '*', 'job', JSON.stringify(freshJob));
    await redis.lrem(DLQ_NAME, 1, entryStr);

    res.json({ redriven: id, status: 'pending' });
});


app.post('/dlq/:id/discard', async (req, res) => {
    const { id } = req.params;

    const raw = await redis.lrange(DLQ_NAME, 0, -1);
    const entryStr = raw.find((e) => JSON.parse(e).id === id);
    if (!entryStr) {
        return res.status(404).json({ error: `Job ${id} not found in DLQ` });
    }

    await redis.lrem(DLQ_NAME, 1, entryStr);
    res.json({ discarded: id });
});

const PORT = process.env.ADMIN_PORT || 4000;
app.listen(PORT, () => {
    console.log(`Admin control plane running on http://localhost:${PORT}`);
    console.log('  GET  /dlq              — list dead jobs');
    console.log('  POST /dlq/:id/redrive  — re-enqueue a dead job');
    console.log('  POST /dlq/:id/discard  — permanently drop a dead job');
});
