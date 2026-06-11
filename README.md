# ⚡ Distributed Task Queue System

A reliable, distributed task queue built with Redis Streams, consumer groups, and gRPC for at-least-once job delivery and status monitoring across multiple worker instances.

## Architecture

```
                  ┌──────────────────┐
                  │   gRPC Client    │
                  │ (SubmitJob RPC)  │
                  └────────┬─────────┘
                           │
                           │ gRPC (Port 50051)
                           ▼
                  ┌──────────────────┐
                  │   gRPC Server    │◀──────────────────────┐
                  │(src/proto/server)│                       │
                  └──────┬────┬──────┘                       │
                         │    │                              │
          Prisma (Save)  │    │ Redis (XADD)                 │ gRPC (ReportJobResult)
                         ▼    ▼                              │
                  ┌──────────┐ ┌─────────────────────┐       │
                  │PostgreSQL│ │    Redis Streams    │       │
                  │ Database │ │    (video-queue)    │       │
                  └──────────┘ └──────────┬──────────┘       │
                                          │                  │
                              XREADGROUP  │                  │
                                          ▼                  │
                              ┌───────────────────────┐      │
                              │     Worker Group      │      │
                              │ (video-workers group) │      │
                              │ ┌─────────┐ ┌─────────┐│      │
                              │ │ Worker1 │ │ Worker2 │├──────┘
                              │ └─────────┘ └─────────┘│
                              └───────────────────────┘
```

## Features

- **Redis Streams as Message Broker** — Durable, append-only log with automatic timestamp-based IDs via `XADD`.
- **Consumer Groups** — Fair work distribution using `XGROUP` / `XREADGROUP` with competing consumers.
- **At-Least-Once Delivery** — `XACK`-based acknowledgment ensures no message is lost, even during worker crashes.
- **Blocking Reads** — Workers use `BLOCK 5000` for efficient, event-driven processing (zero polling waste).
- **gRPC API Service** — Schema-enforced RPC boundaries with protocol buffers for submitting jobs (`SubmitJob`) and reporting worker statuses (`ReportJobResult`).
- **Centralized Persistence** — Prisma ORM + PostgreSQL for durable job metadata and audit trails, decoupled from worker database dependencies.
- **Process-Level Isolation** — Each worker gets a unique consumer name (`worker-${PID}`) for independent scaling.
- **Docker Compose** — Single-command local development with Redis and PostgreSQL.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js + TypeScript |
| Message Broker | Redis Streams |
| Database | PostgreSQL (via Prisma ORM) |
| RPC Framework | gRPC (`@grpc/grpc-js` + `@grpc/proto-loader`) |
| Validation | Zod |
| Containerization | Docker + Docker Compose |
| Dev Tools | TSX (hot reload), Vitest (testing) |

## Quick Start

### 1. Clone & Setup

```bash
# Clone the repo
git clone https://github.com/AdvaithMahendrakar12/Distributed-Task-Queue-System-.git
cd Distributed-Task-Queue-System-

# Install dependencies
npm install

# Start Redis & PostgreSQL services
docker-compose up -d
```

### 2. Start Services

To run the full gRPC-enabled system, you need to spin up the gRPC Server, the Worker processes, and a client/producer to submit jobs.

```bash
# Terminal 1 — Start the gRPC Server
npm run grpc:server

# Terminal 2 — Start worker 1
npm run worker

# Terminal 3 — Start worker 2 (to demonstrate parallel processing)
npm run worker

# Terminal 4 — Submit a job using the gRPC client
npm run grpc:submit
```

*Note: You can still use the direct producer (`npm run producer`) to submit jobs directly to Redis and PostgreSQL, bypassing gRPC.*

### Expected Output

**gRPC Server:**
```
gRPC server running on port 50051
Received job: { videoId: 'vid_001', videoUrl: 'https://example.com/video.mp4' }
Job a1b2c3d4-... saved to DB with status 'pending'
Job a1b2c3d4-... enqueued with stream entry ID: 1711900000000-0
```

**Worker:**
```
Worker group video-workers created
Worker worker-23456 started
Listening for jobs on 'video-queue'...

[NEW] Picked up job a1b2c3d4-...
Job status updated to processing
Processing job a1b2c3d4-... (1080p - 10s)
Result reported: { jobId: 'a1b2c3d4-...', status: 'completed' }
```

## gRPC API Design

The RPC interface is defined in `src/proto/job.proto`:

```protobuf
syntax = "proto3";

package taskqueue;

service JobService { 
    rpc SubmitJob(SubmitJobRequest) returns (SubmitJobResponse);
    rpc ReportJobResult(ReportJobResultRequest) returns (ReportJobResultResponse); 
}

message SubmitJobRequest {
  string video_id  = 1;
  string video_url = 2;
}

message SubmitJobResponse {
  string job_id = 1;
  string status = 2;
}

message ReportJobResultRequest {
  string job_id = 1;
  string status = 2;
  string error_message = 3;
}

message ReportJobResultResponse {
  string job_id = 1;
  string status = 2;
}
```

## Job Schema

```typescript
type VideoJob = {
  id: string;                                    // UUID
  type: 'process_video';                          // Job type
  payload: {
    videoId: string;                              // Video identifier
    videoUrl: string;                             // Source URL
    resolution: '720p' | '1080p';                 // Target resolution
    outputFormat: 'mp4' | 'webm';                 // Output format
  };
  createdAt: string;                              // ISO timestamp
  status: 'pending' | 'processing' | 'completed' | 'failed';
  retryCount: number;
};
```

## How It Works

### gRPC Server (`src/proto/server.ts`)
1. Exposes a gRPC service listening on port `50051`.
2. Implements `SubmitJob` which:
   - Formulates a complete `VideoJob` payload.
   - Saves the job to PostgreSQL via Prisma with a `pending` status.
   - Pushes the job onto the Redis Stream (`video-queue`) via `XADD`.
3. Implements `ReportJobResult` which:
   - Updates the job status (`processing`, `completed`, `failed`) and timestamps (`startedAt`, `completedAt`) in PostgreSQL.

### Worker (`src/workers.ts`)
1. Joins the consumer group `video-workers` on startup.
2. Periodically scans for stuck or stalled jobs using `XAUTOCLAIM`.
3. Listens for new jobs using blocking read `XREADGROUP` (`BLOCK 5000`).
4. When a job is picked up:
   - Calls `ReportJobResult` via the gRPC client to mark the job as `processing`.
   - Simulates video transcoding.
   - On success: updates status to `completed` via gRPC and acknowledges with `XACK`.
   - On failure: updates status to `failed` via gRPC with an error message and acknowledges with `XACK`.

### Client/Producer (`src/proto/client.ts`)
1. Connects to `localhost:50051` over insecure credentials.
2. Initiates the `SubmitJob` RPC request.

---

## Project Structure

```
distributed-task-queue-system/
├── src/
│   ├── index.ts          # Redis & Prisma client initializations
│   ├── producer.ts       # Direct producer script (DB + Redis stream writer)
│   ├── workers.ts        # Worker pool consumer with gRPC result reporting
│   ├── types.ts          # Zod validation & TS type declarations
│   ├── check-db.ts       # DB inspection utility script
│   ├── cleanup.ts        # DB reset/cleanup helper script
│   └── proto/            # gRPC protocol definition & modules
│       ├── job.proto     # Protobuf service definitions
│       ├── server.ts     # gRPC server implementation
│       └── client.ts     # gRPC client entry point to submit jobs
├── prisma/
│   └── schema.prisma     # Prisma database schemas
├── docker-compose.yml    # Redis & PostgreSQL Docker services
├── package.json          # Node script commands & dependencies
└── tsconfig.json         # TypeScript configuration
```

## Scaling Workers

Each worker process gets a unique consumer name based on its process ID (`worker-${process.pid}`). You can run multiple instances to scale processing capacity:

```bash
# Scale to 3 workers
for i in {1..3}; do npm run worker & done
```

Redis Streams will automatically balance new jobs across all active competing worker processes.

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Redis Streams over Pub/Sub** | High durability, historical replays, at-least-once processing, and built-in consumer groups. |
| **gRPC Server for Persistence** | Decentralizes database interaction so worker instances don't need direct PostgreSQL/Prisma connections, minimizing pool sizing limits and isolation risks. |
| **Blocking Reads (`BLOCK 5000`)** | Eliminates polling overhead and keeps worker processes event-driven. |
| **XAUTOCLAIM for Fault Tolerance** | Automatically detects and reclaims tasks from workers that crash mid-processing. |

---

## License

MIT
