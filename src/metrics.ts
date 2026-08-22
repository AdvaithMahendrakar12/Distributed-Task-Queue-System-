import { redis } from '.';

export const incrCounter = (name: string) =>
    redis.incr(`metrics:${name}`);

const COUNTERS: Record<string, string> = {
    jobs_completed_total: 'Jobs that finished successfully',
    jobs_failed_total: 'Failed processing attempts that were scheduled to retry',
    jobs_dead_total: 'Jobs that exhausted retries and moved to the DLQ',
};

export const renderMetrics = async (): Promise<string> => {
    const names = Object.keys(COUNTERS);
    const values = await Promise.all(
        names.map((name) => redis.get(`metrics:${name}`))
    );

    const lines = [
        '# HELP dtqs_up 1 if the admin server is serving metrics',
        '# TYPE dtqs_up gauge',
        'dtqs_up 1',
        '',
    ];

    names.forEach((name, i) => {
        lines.push(`# HELP ${name} ${COUNTERS[name]}`);
        lines.push(`# TYPE ${name} counter`);
        lines.push(`${name} ${Number(values[i] ?? 0)}`);
        lines.push('');
    });

    return lines.join('\n');
};
