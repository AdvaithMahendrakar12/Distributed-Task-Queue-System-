// grpc/server.ts
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'

// 1. Load your proto file
const packageDef = protoLoader.loadSync('proto/job.proto')
const grpcObject = grpc.loadPackageDefinition(packageDef)
const taskqueue = (grpcObject as any).taskqueue

// 2. Implement SubmitJob
const submitJob = (call: any, callback: any) => {
    console.log('Received job:', call.request)
    callback(null, {
        jobId: crypto.randomUUID(),
        status: 'pending'
    })
}

// 3. Start server
const server = new grpc.Server()
server.addService(taskqueue.JobService.service, { submitJob })
server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), () => {
    console.log('gRPC server running on port 50051')
})