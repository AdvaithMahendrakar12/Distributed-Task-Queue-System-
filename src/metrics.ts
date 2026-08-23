import { redis, prisma } from '.';

export const incrCounter = (name: string) =>
    redis.incr(`metrics:${name}`);

const COUNTERS: Record<string, string> = {
    jobs_completed_total: 'Jobs that finished successfully',
    jobs_failed_total: 'Failed processing attempts that were scheduled to retry',
    jobs_dead_total: 'Jobs that exhausted retries and moved to the DLQ',
};

const STREAM_NAME = 'video-queue';
const RETRY_ZSET = 'video-retry';
const DLQ_NAME = 'video-dlq';

export const renderMetrics = async (): Promise<string> => {
    const names = Object.keys(COUNTERS);
    const [counterValues, streamLength, retryDepth, dlqDepth, outboxUnpublished] = await Promise.all([
        Promise.all(names.map((name) => redis.get(`metrics:${name}`))),
        redis.xlen(STREAM_NAME),
        redis.zcard(RETRY_ZSET),
        redis.llen(DLQ_NAME),
        prisma.outbox.count({ where: { published: false } }),
    ]);

    const lines = [
        '# HELP dtqs_up 1 if the admin server is serving metrics',
        '# TYPE dtqs_up gauge',
        'dtqs_up 1',
        '',
    ];

    names.forEach((name, i) => {
        lines.push(`# HELP ${name} ${COUNTERS[name]}`);
        lines.push(`# TYPE ${name} counter`);
        lines.push(`${name} ${Number(counterValues[i] ?? 0)}`);
        lines.push('');
    });

    const gauges: [string, string, number][] = [
        ['video_queue_stream_length', 'Entries currently in the main Redis stream', streamLength],
        ['video_retry_zset_depth', 'Jobs waiting in the delayed-retry ZSET', retryDepth],
        ['video_dlq_depth', 'Jobs currently sitting in the dead-letter queue', dlqDepth],
        ['outbox_unpublished_depth', 'Outbox rows not yet published to the stream', outboxUnpublished],
    ];
    for (const [name, help, value] of gauges) {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} gauge`);
        lines.push(`${name} ${value}`);
        lines.push('');
    }

    return lines.join('\n');
};
