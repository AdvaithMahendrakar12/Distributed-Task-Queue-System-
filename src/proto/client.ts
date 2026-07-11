// grpc/client.ts
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

const packageDef = protoLoader.loadSync('./src/proto/job.proto')
const grpcObject = grpc.loadPackageDefinition(packageDef)
const taskqueue = (grpcObject as any).taskqueue

const client = new taskqueue.JobService(
    'localhost:50051',
    grpc.credentials.createInsecure()
)

const idempotencyKey = process.env.IDEMPOTENCY_KEY || crypto.randomUUID()
console.log('Submitting with idempotency key:', idempotencyKey)

// Call SubmitJob
client.submitJob({ videoId: 'vid_001', videoUrl: 'https://example.com/video.mp4', idempotencyKey }, (err: any, response: any) => {
    console.log('Response:', response)
})

