import { prisma } from './index';

async function checkDB() {
    const jobs = await prisma.job.findMany({
        orderBy: { createdAt: 'desc' },
    });

    if (jobs.length === 0) {
        console.log('No jobs in DB');
    } else {
        console.log(`\n📋 Jobs in DB (${jobs.length}):\n`);
        for (const job of jobs) {
            console.log(`  ID:        ${job.id}`);
            console.log(`  Status:    ${job.status}`);
            console.log(`  Worker:    ${job.workerId || 'none'}`);
            console.log(`  Retries:   ${job.retryCount}`);
            console.log(`  Error:     ${job.errorMessage || 'none'}`);
            console.log(`  Created:   ${job.createdAt}`);
            console.log(`  Started:   ${job.startedAt || 'not yet'}`);
            console.log(`  Completed: ${job.completedAt || 'not yet'}`);
            console.log('  ---');
        }
    }

    await prisma.$disconnect();
}

checkDB();
