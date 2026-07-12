# ⚡ Distributed Task Queue System

A reliable, distributed task queue built with Redis Streams, consumer groups, and gRPC for at-least-once job delivery and status monitoring across multiple worker instances. Includes production-style reliability: a transactional outbox for lossless enqueue, client-supplied idempotency keys for dedupe, exponential backoff with jitter for retries, a dead-letter queue, and an operator control plane for redriving failed jobs.

## Architecture

```
                  ┌──────────────────┐
                  │   gRPC Client    │  idempotency_key (dedupe)
                  │ (SubmitJob RPC)  │
                  └────────┬─────────┘
                           │ gRPC (Port 50051)
                           ▼
                  ┌──────────────────┐
                  │   gRPC Server    │◀──────────────────────┐
                  │(src/proto/server)│                       │
                  └────────┬─────────┘                       │
                           │ ONE transaction                 │ gRPC (ReportJobResult)
                           │ (Job + Outbox rows)             │  atomic retryCount++
                           ▼                                 │  dead vs failed decision
                  ┌──────────────────┐                       │
                  │   PostgreSQL     │                       │
                  │  Job + Outbox    │                       │
                  └────────┬─────────┘                       │
                  poll unpublished │  ▲ mark published        │
                                   ▼  │                       │
                          ┌──────────────────┐               │
                          │      Relay       │ (sole stream publisher)
                          │ (steady 1s poll) │               │
                          └────────┬─────────┘               │
                                   │ XADD                    │
                                   ▼                         │
                          ┌─────────────────────┐            │
                          │    Redis Streams    │◀──┐        │
                          │    (video-queue)    │   │        │
                          └──────────┬──────────┘   │        │
                              XREADGROUP │      XADD when due │
                                        ▼            │       │
                            ┌───────────────────────┐│       │
                            │     Worker Group      ││       │
                            │ (video-workers group) ││       │
                            │ ┌─────────┐ ┌─────────┐│       │
                            │ │ Worker1 │ │ Worker2 │├───────┘
                            │ └─────────┘ └─────────┘│
                            └───────┬───────┬───────┘│
                      failed (retry)│       │dead    │
                       ZADD due-time│       │LPUSH   │
                                    ▼       ▼        │
                      ┌──────────────────┐ ┌──────────────────┐
                      │  Retry ZSET      │ │  DLQ (video-dlq) │
                      │ (video-retry)    │ │   Redis list     │
                      │ score = dueAt    │ └────────┬─────────┘
                      └────────┬─────────┘          │
                   ZRANGEBYSCORE│                    │ LRANGE / LREM
                                ▼                    ▼
                      ┌──────────────────┐ ┌──────────────────┐
                      │    Scheduler     │ │   Admin API      │
                      │ (steady 1s poll) │ │ list/redrive/    │
                      │ re-enqueue ──────┘ │ discard (:4000)  │
                      └──────────────────┘ └──────────────────┘
```

## Features

- **Redis Streams as Message Broker** — Durable, append-only log with automatic timestamp-based IDs via `XADD`.
- **Consumer Groups** — Fair work distribution using `XGROUP` / `XREADGROUP` with competing consumers.
- **At-Least-Once Delivery** — `XACK`-based acknowledgment ensures no message is lost, even during worker crashes.
- **Blocking Reads** — Workers use `BLOCK 5000` for efficient, event-driven processing (zero polling waste).
- **gRPC API Service** — Schema-enforced RPC boundaries with protocol buffers for submitting jobs (`SubmitJob`) and reporting worker statuses (`ReportJobResult`).
- **Centralized Persistence** — Prisma ORM + PostgreSQL for durable job metadata and audit trails, decoupled from worker database dependencies.
- **Transactional Outbox** — `SubmitJob` writes the Job row and an Outbox row in a single DB transaction and never touches Redis; a relay is the sole publisher to the stream. This removes the dual-write, so a crash can never leave a job persisted-but-never-enqueued.
- **Idempotent Submission** — A client-supplied `idempotencyKey` (unique-constrained) dedupes retried submits: the server returns the existing job instead of creating a duplicate, and a `P2002` catch closes the concurrent-request race.
- **Atomic Retry Counting** — The server increments `retryCount` with a single `UPDATE ... RETURNING`, so concurrent reclaimers can never lose an update.
- **Exponential Backoff + Jitter** — Failed jobs are parked in a Redis sorted set (`video-retry`) scored by a jittered due-time, then released by a steady-cadence scheduler. The jitter de-synchronizes herds of jobs that fail together, preventing a thundering-herd retry storm.
- **Dead-Letter Queue (DLQ)** — After `FAILED_COUNT` (5) attempts a job is quarantined in a Redis list (`video-dlq`) instead of being lost or retried forever.
- **Operator Control Plane** — A separate Express admin API to inspect the DLQ and human-trigger **redrive** (retry) or **discard** (drop) — deliberately decoupled from the automatic worker data plane.
- **Two-Mode Fault Tolerance** — `XAUTOCLAIM` recovers jobs from *crashed* workers (PEL reclaim); the retry ZSET handles *failed-but-alive* jobs. Different failure modes, different mechanisms.
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

The full system is a set of cooperating processes: the gRPC server, one or more workers, the outbox relay, the retry scheduler, the admin control plane, and a client to submit jobs.

```bash
# Terminal 1 — Start the gRPC Server
npm run grpc:server

# Terminal 2 — Start worker 1
npm run worker

# Terminal 3 — Start worker 2 (to demonstrate parallel processing)
npm run worker

# Terminal 4 — Start the outbox relay (publishes committed jobs to the stream)
npm run relay

# Terminal 5 — Start the retry scheduler (releases backed-off jobs when due)
npm run scheduler

# Terminal 6 — Start the admin control plane (DLQ inspect / redrive / discard)
npm run admin

# Terminal 7 — Submit a job using the gRPC client
npm run grpc:submit
```

*Note: the relay is what moves a submitted job from the outbox to the stream. Without it running, jobs stay in the outbox (`published=false`) and never reach a worker.*

### Idempotent Submits

The client sends an `idempotencyKey` (random per run, or set `IDEMPOTENCY_KEY` to reuse). Resubmitting with the same key returns the existing job instead of creating a duplicate:

```bash
IDEMPOTENCY_KEY=demo-123 npm run grpc:submit   # creates the job
IDEMPOTENCY_KEY=demo-123 npm run grpc:submit   # returns the same jobId, no duplicate
```

*Note: You can still use the direct producer (`npm run producer`) to submit jobs directly to Redis and PostgreSQL, bypassing gRPC and the outbox.*

### Admin / DLQ Endpoints

The admin control plane ([`src/admin.ts`](src/admin.ts)) runs on port `4000`:

```bash
# List all dead jobs waiting for triage
curl http://localhost:4000/dlq

# Redrive a dead job — reset its retry count and re-enqueue it
curl -X POST http://localhost:4000/dlq/<job-id>/redrive

# Discard a dead job permanently (the PostgreSQL row remains as history)
curl -X POST http://localhost:4000/dlq/<job-id>/discard
```

### Expected Output

**gRPC Server:**
```
gRPC server running on port 50051
Received job: { videoId: 'vid_001', videoUrl: 'https://example.com/video.mp4', idempotencyKey: '...' }
Job a1b2c3d4-... saved to DB + outbox (pending)
```

**Relay:**
```
Outbox relay started — polling for unpublished jobs every 1000ms
[RELAY] Published job a1b2c3d4-...
```

**Worker:**
```
Worker group video-workers created
Worker worker-23456 started
Listening for jobs on 'video-queue'...

[NEW] Picked up job a1b2c3d4-...
Job a1b2c3d4-... status updated to processing
Processing job a1b2c3d4-... (1080p - 10s)
Job a1b2c3d4-... completed
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
  string idempotency_key = 3;  // client-supplied, stable across retries; server dedupes on it
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
  string status = 2;      // resolved status: 'dead' once the retry limit is hit
  int32 retry_count = 3;  // attempt number, used by the worker to compute backoff
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
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
  retryCount: number;
};

// The Job row also carries a unique, nullable `idempotencyKey` (client-supplied,
// for dedupe). Enqueue intent is recorded in a companion `Outbox` row written in
// the same transaction; the relay publishes it and flips `published`.
```

## How It Works

### gRPC Server (`src/proto/server.ts`)
1. Exposes a gRPC service listening on port `50051`.
2. Implements `SubmitJob` which:
   - Checks the client-supplied `idempotencyKey`; if a job already exists for it, returns that job (no duplicate).
   - Otherwise writes the `Job` row (`pending`) **and** an `Outbox` row in a **single `prisma.$transaction`** — and never touches Redis. This is the transactional outbox: no dual-write in the request path.
   - Catches a `P2002` unique violation (two identical requests racing) and returns the winner's job.
3. Implements `ReportJobResult` which:
   - For `processing`/`completed`: updates status and timestamps (`startedAt`, `completedAt`) in PostgreSQL.
   - For `failed`: **atomically** bumps `retryCount` with a single `UPDATE ... RETURNING`, then decides `dead` vs `failed` based on `FAILED_COUNT` (5). Returns the resolved status and the new `retryCount` to the worker.

### Worker (`src/workers.ts`)
1. Joins the consumer group `video-workers` on startup.
2. Periodically scans for jobs abandoned by *crashed* workers using `XAUTOCLAIM` (PEL reclaim).
3. Listens for new jobs using blocking read `XREADGROUP` (`BLOCK 5000`).
4. When a job is picked up:
   - Calls `ReportJobResult` via the gRPC client to mark the job as `processing`.
   - Simulates video transcoding.
   - **On success:** acknowledges with `XACK` and reports `completed` (best-effort, after the ack).
   - **On failure — not yet dead:** computes a jittered due-time via `backoff(retryCount)`, `ZADD`s the job into the retry ZSET (`video-retry`), then `XACK`s. (`ZADD` before `XACK` — a crash in between leaves the job reclaimable, not lost.)
   - **On failure — dead:** `LPUSH`es the job into the DLQ (`video-dlq`), then `XACK`s.

### Relay (`src/relay.ts`)
The **only** publisher to the stream. It closes the dual-write gap that `SubmitJob` deliberately left open:
1. Polls PostgreSQL for `Outbox` rows where `published = false` on a steady 1-second heartbeat.
2. `XADD`s each to the main stream, then flips `published = true` (publish *before* mark — a crash yields a re-published duplicate, absorbed by idempotency, never a lost job).
3. Because enqueue intent is a durable row written atomically with the job, a crashed `SubmitJob` can't lose work — the relay picks it up on the next tick. The happy path and the crash-recovery path are the same path.

### Scheduler (`src/scheduler.ts`)
1. Polls the retry ZSET on a steady 1-second heartbeat.
2. `ZRANGEBYSCORE video-retry 0 <now>` fetches jobs whose due-time has passed.
3. Re-enqueues each onto the main stream (`XADD`) then removes it from the ZSET (`ZREM`).
4. The stagger that breaks a thundering herd lives in each job's **score**, not in this poll interval — the scheduler is deliberately metronomic.

### Admin Control Plane (`src/admin.ts`)
An Express server on port `4000` for human-triggered DLQ operations:
- `GET /dlq` — list dead jobs (`LRANGE`).
- `POST /dlq/:id/redrive` — reset the retry count and re-enqueue (`XADD` before `LREM`).
- `POST /dlq/:id/discard` — permanently remove from the DLQ (`LREM`); the PostgreSQL row remains as history.

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
│   ├── workers.ts        # Worker pool consumer: backoff scheduling + DLQ routing
│   ├── relay.ts          # Outbox relay: sole publisher of committed jobs to the stream
│   ├── scheduler.ts      # Retry scheduler: drains the video-retry ZSET when due
│   ├── admin.ts          # Admin control plane: DLQ inspect / redrive / discard
│   ├── types.ts          # Zod validation & TS type declarations
│   ├── check-db.ts       # DB inspection utility script
│   ├── cleanup.ts        # DB reset/cleanup helper script
│   └── proto/            # gRPC protocol definition & modules
│       ├── job.proto     # Protobuf service definitions
│       ├── server.ts     # gRPC server implementation
│       └── client.ts     # gRPC client entry point to submit jobs
├── prisma/
│   ├── schema.prisma     # Prisma schemas (Job + Outbox)
│   └── migrations/       # SQL migration history
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
| **Transactional Outbox** | Writing the job and its enqueue-intent in one DB transaction (and letting a relay publish) removes the persist-then-enqueue dual-write, so a crash can't strand a job that's saved but never queued. |
| **Client-Supplied Idempotency Key** | A stable, client-generated key (not a per-request server UUID) is the only way to recognize a retried submit as the same logical request; a unique constraint makes the dedupe race-safe. |
| **Blocking Reads (`BLOCK 5000`)** | Eliminates polling overhead and keeps worker processes event-driven. |
| **XAUTOCLAIM for Fault Tolerance** | Automatically detects and reclaims tasks from workers that crash mid-processing. |
| **ZSET Scheduled Queue for Retries** | A single global `XAUTOCLAIM` idle-time can't express per-attempt backoff; a sorted set keyed by due-time can, and makes "what's due now?" a cheap range query. |
| **Jitter in the Score, Not the Poll** | Randomizing each job's due-time (not the scheduler cadence) is what actually scatters a synchronized retry herd across time. |
| **Add-to-Destination-Before-Remove** | Every cross-store move (stream→DLQ, stream→ZSET, ZSET→stream) adds to the target before removing from the source, so a mid-move crash yields a recoverable duplicate rather than data loss. |
| **Control Plane vs Data Plane** | Redrive is an operator decision, never automatic — auto-reprocessing a DLQ just rebuilds the infinite retry loop the DLQ exists to stop. |
| **Atomic `retryCount` Increment** | `UPDATE ... RETURNING` performs read-modify-write in one statement, so two concurrent reclaimers can't both read the same stale count. |

---

## License

MIT
