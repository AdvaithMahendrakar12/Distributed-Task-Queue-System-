import { redis, prisma } from './index';

async function cleanup() {
    await redis.del('video-queue');
    await prisma.job.deleteMany();
    console.log('✅ Cleaned up Redis stream and DB');
    await prisma.$disconnect();
    await redis.quit();
}

cleanup();
