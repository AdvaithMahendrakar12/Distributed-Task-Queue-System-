
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { prisma, redis } from '..'
import { VideoJob } from '../types'

// 1. Load your proto file
const packageDef = protoLoader.loadSync('proto/job.proto')
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
            'video-queue',  // stream name
            '*',            // auto-generate ID (timestamp-based)
            'job', JSON.stringify(job)
        );
        console.log(`Job ${job.id} enqueued with stream entry ID: ${entryId}`);
          callback(null, {
            jobId: crypto.randomUUID(),
            status: 'pending'
        })
    
}

const server = new grpc.Server()
server.addService(taskqueue.JobService.service, { submitJob })
server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), () => {
    console.log('gRPC server running on port 50051')
})
