import { redis, prisma } from './index';
import { VideoJob } from './types';


const enqueueJob = async (job: VideoJob) => {

    await prisma.job.create({
        data: {
            id: job.id,
            type: job.type,
            payload: job.payload,
            status: 'pending',
            retryCount: 0,
            createdAt: new Date(job.createdAt),
        }
    });
    console.log(`Job ${job.id} saved to DB with status 'pending'`);

    const entryId = await redis.xadd(
        'video-queue',  // stream name
        '*',            // auto-generate ID (timestamp-based)
        'job', JSON.stringify(job)
    );
    console.log(`Job ${job.id} enqueued with stream entry ID: ${entryId}`);
}

const assignjob = (): VideoJob => {
    const job: VideoJob = {
        id: crypto.randomUUID(),
        type: 'process_video',
        payload: {
            videoId: 'vid_001',
            videoUrl: 'https://example.com/video.mp4',
            resolution: '1080p',
            outputFormat: 'mp4',
        },
        createdAt: new Date().toISOString(),
        status: 'pending',
        retryCount: 0,
    };

    return job;
};

(async () => {
    await enqueueJob(assignjob());
    await prisma.$disconnect();
    await redis.quit();
})();