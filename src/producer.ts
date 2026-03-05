import { redis } from './index';
import { VideoJob } from './types';


const enqueueJob = async (job: VideoJob) => {
    const entryId = await redis.xadd(
        'video-queue',  // stream name
        '*',            // auto-generate ID (timestamp-based)
        'job', JSON.stringify(job)
    );
    console.log(`Job ${job.id} enqueued with stream entry ID: ${entryId}`);
}

const assignjob = () => {
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
    };

    return job;
};

(async () => {
    await enqueueJob(assignjob());
    await redis.quit();
})();