import * as fs from 'fs';
import * as path from 'path';
import { AWClient, IEvent } from '../aw-client-js/src/aw-client';
import {
    BUCKET_EVENT_TYPE_FILE_ACTIVITY,
    BUCKET_SUFFIX_FILE_ACTIVITY,
    FileActivityKind,
    WATCHER_CLIENT_NAME
} from '../src/events';

// 文件活动事件数据，对应单条轨道（查看 + 编辑合并）。
interface IFileActivityEventData {
    [key: string]: unknown;
    project: string;
    file: string;
    language: string;
    branch: string;
    workspaceId: string;
    activityKind?: FileActivityKind;
}

interface IFileActivityAggregate {
    totalEvents: number;
    totalDurationSec: number;
    projects: { [project: string]: number };
    languages: { [language: string]: number };
    files: { [file: string]: number };
    activityKinds: { [activityKind: string]: number };
}

interface IReportOutput {
    generatedAt: string;
    start: string;
    end: string;
    fileActivity: {
        bucketId: string;
        aggregate: IFileActivityAggregate;
    };
}

function getArgValue(flag: string): string | undefined {
    const found = process.argv.find((item: string) => item.indexOf(`${flag}=`) === 0);
    return found ? found.split('=').slice(1).join('=') : undefined;
}

function incrementCounter(target: { [key: string]: number }, key: string): void {
    const safeKey = key || 'unknown';
    target[safeKey] = (target[safeKey] || 0) + 1;
}

function sumDuration(current: number, duration: number | undefined): number {
    return current + (typeof duration === 'number' ? duration : 0);
}

function isFileActivityEventData(data: Record<string, unknown>): data is IFileActivityEventData {
    return typeof data.project === 'string' && typeof data.file === 'string' && typeof data.language === 'string';
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

async function readEvents(client: AWClient, bucketId: string, start: Date, end: Date): Promise<IEvent[]> {
    return client.getEvents(bucketId, {
        start: start.toISOString(),
        end: end.toISOString()
    });
}

function aggregateFileActivityEvents(events: IEvent[]): IFileActivityAggregate {
    const aggregate: IFileActivityAggregate = {
        totalEvents: 0,
        totalDurationSec: 0,
        projects: {},
        languages: {},
        files: {},
        activityKinds: {}
    };

    events.forEach((event: IEvent) => {
        const eventData = event.data as Record<string, unknown>;
        if (!isFileActivityEventData(eventData)) {
            return;
        }
        aggregate.totalEvents += 1;
        aggregate.totalDurationSec = sumDuration(aggregate.totalDurationSec, event.duration);
        incrementCounter(aggregate.projects, eventData.project);
        incrementCounter(aggregate.languages, eventData.language);
        incrementCounter(aggregate.files, eventData.file);
        incrementCounter(aggregate.activityKinds, typeof eventData.activityKind === 'string' ? eventData.activityKind : 'unknown');
    });

    return aggregate;
}

async function main() {
    const hoursRaw = getArgValue('--hours');
    const outputFile = getArgValue('--output') || path.join(process.cwd(), 'project-report.json');
    const hours = hoursRaw ? Number(hoursRaw) : 24;
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);

    const client = new AWClient('aw-watcher-vscode-report');
    const fileActivityBucketId = await findBucketId(client, BUCKET_EVENT_TYPE_FILE_ACTIVITY, BUCKET_SUFFIX_FILE_ACTIVITY);
    const fileActivityEvents = await readEvents(client, fileActivityBucketId, start, end);

    const report: IReportOutput = {
        generatedAt: new Date().toISOString(),
        start: start.toISOString(),
        end: end.toISOString(),
        fileActivity: {
            bucketId: fileActivityBucketId,
            aggregate: aggregateFileActivityEvents(fileActivityEvents)
        }
    };
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), { encoding: 'utf8' });
    console.log(`Project report saved to ${outputFile}`);
}

main().catch((err: Error) => {
    console.error('Failed to build project report:', err.message);
    process.exit(1);
});
