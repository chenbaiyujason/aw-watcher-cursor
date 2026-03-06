import * as fs from 'fs';
import * as path from 'path';
import { AWClient, IEvent } from '../aw-client-js/src/aw-client';
import { BUCKET_EVENT_TYPE_AGENT_LIFECYCLE, WATCHER_CLIENT_NAME } from '../src/events';

interface IAgentEventData {
    [key: string]: unknown;
    eventName: string;
    taskKind: string;
    outcome: string;
    commandId: string;
    sessionId: string;
    project: string;
}

interface IAgentAggregate {
    totalEvents: number;
    eventNames: { [eventName: string]: number };
    taskKinds: { [taskKind: string]: number };
    outcomes: { [outcome: string]: number };
    commands: { [commandId: string]: number };
    projects: { [project: string]: number };
}

interface IReportOutput {
    generatedAt: string;
    bucketId: string;
    start: string;
    end: string;
    aggregate: IAgentAggregate;
}

function getArgValue(flag: string): string | undefined {
    const found = process.argv.find((item: string) => item.indexOf(`${flag}=`) === 0);
    return found ? found.split('=').slice(1).join('=') : undefined;
}

function incrementCounter(target: { [key: string]: number }, key: string): void {
    const safeKey = key || 'unknown';
    target[safeKey] = (target[safeKey] || 0) + 1;
}

function isAgentEventData(data: Record<string, unknown>): data is IAgentEventData {
    return typeof data.eventName === 'string' && typeof data.commandId === 'string';
}

async function findBucketId(client: AWClient, eventType: string, bucketSuffix: string): Promise<string> {
    const buckets = await client.getBuckets();
    const bucketIds = Object.keys(buckets).sort();
    const preferredIds = bucketIds.filter((bucketId) =>
        buckets[bucketId].type === eventType && bucketId.indexOf(`${WATCHER_CLIENT_NAME}-${bucketSuffix}_`) === 0
    );
    if (preferredIds.length > 0) {
        return preferredIds[preferredIds.length - 1];
    }
    for (let i = 0; i < bucketIds.length; i += 1) {
        if (buckets[bucketIds[i]].type === eventType) {
            return bucketIds[i];
        }
    }
    throw new Error(`Bucket with type ${eventType} not found.`);
}

async function main() {
    const hoursRaw = getArgValue('--hours');
    const outputFile = getArgValue('--output') || path.join(process.cwd(), 'agent-report.json');
    const hours = hoursRaw ? Number(hoursRaw) : 24;
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);

    const client = new AWClient('aw-watcher-vscode-report');
    const bucketId = await findBucketId(client, BUCKET_EVENT_TYPE_AGENT_LIFECYCLE, 'agent');
    const events = await client.getEvents(bucketId, {
        start: start.toISOString(),
        end: end.toISOString()
    });

    const aggregate: IAgentAggregate = {
        totalEvents: 0,
        eventNames: {},
        taskKinds: {},
        outcomes: {},
        commands: {},
        projects: {}
    };

    events.forEach((event: IEvent) => {
        const eventData = event.data as Record<string, unknown>;
        if (!isAgentEventData(eventData)) {
            return;
        }
        aggregate.totalEvents += 1;
        incrementCounter(aggregate.eventNames, eventData.eventName);
        incrementCounter(aggregate.taskKinds, eventData.taskKind || 'unknown');
        incrementCounter(aggregate.outcomes, eventData.outcome || 'unknown');
        incrementCounter(aggregate.commands, eventData.commandId);
        incrementCounter(aggregate.projects, eventData.project || 'unknown');
    });

    const report: IReportOutput = {
        generatedAt: new Date().toISOString(),
        bucketId,
        start: start.toISOString(),
        end: end.toISOString(),
        aggregate
    };
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), { encoding: 'utf8' });
    console.log(`Agent report saved to ${outputFile}`);
}

main().catch((err: Error) => {
    console.error('Failed to build agent report:', err.message);
    process.exit(1);
});
