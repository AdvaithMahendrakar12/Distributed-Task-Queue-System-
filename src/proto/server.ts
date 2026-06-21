
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { prisma, redis } from '..'
import { VideoJob } from '../types'

// 1. Load your proto file
const packageDef = protoLoader.loadSync('./src/proto/job.proto')
const grpcObject = grpc.loadPackageDefinition(packageDef)
const taskqueue = (grpcObject as any).taskqueue

const submitJob = async (call: any, callback: any) => {
    console.log('Received job:', call.request)
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
            'video-queue',
            '*',
            'job', JSON.stringify(job)
        );
        console.log(`Job ${job.id} enqueued with stream entry ID: ${entryId}`);
        callback(null, {
            jobId: job.id,
            status: 'pending'
        })
}


const FAILED_COUNT = 5;

const reportJobResult = async (call: any, callback: any) => {
    const { jobId, status, errorMessage } = call.request

    let resolvedStatus = status;

    if (status === 'failed'){
        const [{ retryCount: newCount }] = await prisma.$queryRaw<{ retryCount: number }[]>`
            UPDATE "Job"
            SET "retryCount" = "retryCount" + 1,
                "errorMessage" = ${errorMessage || null}
            WHERE id = ${jobId}
            RETURNING "retryCount"
        `;
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

    callback(null, { jobId, status: resolvedStatus })
}

const server = new grpc.Server()
server.addService(taskqueue.JobService.service, { submitJob, reportJobResult })
server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), () => {
    console.log('gRPC server running on port 50051')
})
