
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { prisma } from '..'
import { VideoJob } from '../types'
import { incrCounter } from '../metrics'

// 1. Load your proto file
const packageDef = protoLoader.loadSync('./src/proto/job.proto')
const grpcObject = grpc.loadPackageDefinition(packageDef)
const taskqueue = (grpcObject as any).taskqueue

const submitJob = async (call: any, callback: any) => {
    console.log('Received job:', call.request)
    const idempotencyKey: string = call.request.idempotencyKey || '';


    if (idempotencyKey) {
        const existing = await prisma.job.findUnique({ where: { idempotencyKey } });
        if (existing) {
            console.log(`Duplicate submit for key '${idempotencyKey}' — returning existing job ${existing.id}`);
            await incrCounter('jobs_duplicate_submit_total');
            return callback(null, { jobId: existing.id, status: existing.status });
        }
    }

    const job: VideoJob = {
        id: crypto.randomUUID(),
        type: 'process_video',
        payload: {
            videoId: call.request.videoId,
            videoUrl: call.request.videoUrl,
            resolution: '1080p',
            outputFormat: 'mp4',
        },
        createdAt: new Date().toISOString(),
        status: 'pending',
        retryCount: 0,
    };

    try {
        // Transactional outbox: the Job row and the Outbox row commit together
        // in one DB transaction
        await prisma.$transaction([
            prisma.job.create({
                data: {
                    id: job.id,
                    type: job.type,
                    payload: job.payload,
                    status: 'pending',
                    retryCount: 0,
                    idempotencyKey: idempotencyKey || null,
                    createdAt: new Date(job.createdAt),
                }
            }),
            prisma.outbox.create({
                data: {
                    jobId: job.id,
                    payload: JSON.stringify(job),
                }
            }),
        ]);
        console.log(`Job ${job.id} saved to DB + outbox (pending)`);
        await incrCounter('jobs_submitted_total');

        callback(null, { jobId: job.id, status: 'pending' });
    } catch (err: any) {
        // A concurrent identical request won the race and inserted the key first.
        // The unique constraint rejects ours (P2002); return the winner's job.
        if (err?.code === 'P2002' && idempotencyKey) {
            const existing = await prisma.job.findUnique({ where: { idempotencyKey } });
            console.log(`Race on key '${idempotencyKey}' — returning existing job ${existing?.id}`);
            await incrCounter('jobs_duplicate_submit_total');
            return callback(null, { jobId: existing?.id, status: existing?.status });
        }
        console.error('submitJob failed:', err);
        callback(err);
    }
}


const FAILED_COUNT = 5;

const reportJobResult = async (call: any, callback: any) => {
    const { jobId, status, errorMessage } = call.request

    let resolvedStatus = status;
    let retryCount = 0;

    if (status === 'processing') {
        // Atomic claim. The worker asks for the job in the same call that used
        // to just mark it 'processing'. The WHERE clause refuses the claim if a
        // previous delivery already drove the job to a terminal state, so a
        // duplicate delivery becomes a no-op instead of duplicate work.
        //
        // 'processing' is deliberately still claimable: a worker can die
        // mid-job leaving the row stuck there, and XAUTOCLAIM must be able to
        // hand that job to a healthy worker.
        const claimedRows = await prisma.$queryRaw<{ id: string }[]>`
            UPDATE "Job"
            SET status = 'processing',
                "startedAt" = now()
            WHERE id = ${jobId}
              AND status NOT IN ('completed', 'dead')
            RETURNING id
        `;
        const claimed = claimedRows.length > 0;
        return callback(null, {
            jobId,
            status: claimed ? 'processing' : 'skip',
            retryCount: 0,
            claimed,
        });
    }

    if (status === 'failed'){
        const [{ retryCount: newCount }] = await prisma.$queryRaw<{ retryCount: number }[]>`
            UPDATE "Job"
            SET "retryCount" = "retryCount" + 1,
                "errorMessage" = ${errorMessage || null}
            WHERE id = ${jobId}
            RETURNING "retryCount"
        `;
        retryCount = newCount;
        resolvedStatus = newCount >= FAILED_COUNT ? 'dead' : 'failed';

        await prisma.job.update({
            where: { id: jobId },
            data: { status: resolvedStatus }
        });
    } else {
        await prisma.job.update({
            where: { id: jobId },
            data: {
                status,
                startedAt: status === 'processing' ? new Date() : undefined,
                completedAt: status === 'completed' ? new Date() : undefined,
                errorMessage: errorMessage || null,
            }
        });
    }

    callback(null, { jobId, status: resolvedStatus, retryCount, claimed: true })
}

const server = new grpc.Server()
server.addService(taskqueue.JobService.service, { submitJob, reportJobResult })
server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), () => {
    console.log('gRPC server running on port 50051')
})
