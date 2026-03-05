import * as fs from 'fs';
import * as path from 'path';
import { AWClient, IEvent } from '../aw-client-js/src/aw-client';

interface IProjectEventData {
    [key: string]: unknown;
    project: string;
    file: string;
    language: string;
    branch: string;
    workspaceId: string;
    editorSessionId: string;
}

interface IProjectAggregate {
    totalEvents: number;
    projects: { [project: string]: number };
    languages: { [language: string]: number };
    files: { [file: string]: number };
    branches: { [branch: string]: number };
}

interface IReportOutput {
    generatedAt: string;
    bucketId: string;
    start: string;
    end: string;
    aggregate: IProjectAggregate;
}

function getArgValue(flag: string): string | undefined {
    const found = process.argv.find((item) => item.indexOf(`${flag}=`) === 0);
    return found ? found.split('=').slice(1).join('=') : undefined;
}

function incrementCounter(target: { [key: string]: number }, key: string): void {
    const safeKey = key || 'unknown';
    target[safeKey] = (target[safeKey] || 0) + 1;
}

function isProjectEventData(data: Record<string, unknown>): data is IProjectEventData {
    return typeof data.project === 'string' && typeof data.file === 'string' && typeof data.language === 'string';
}

async function findBucketId(client: AWClient, eventType: string): Promise<string> {
    const buckets = await client.getBuckets();
    const bucketIds = Object.keys(buckets).sort();
    const preferredIds = bucketIds.filter((bucketId) =>
        buckets[bucketId].type === eventType && bucketId.indexOf('aw-watcher-vscode_') === 0
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
    const outputFile = getArgValue('--output') || path.join(process.cwd(), 'project-report.json');
    const hours = hoursRaw ? Number(hoursRaw) : 24;
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);

    const client = new AWClient('aw-watcher-vscode-report');
    const bucketId = await findBucketId(client, 'app.editor.activity');
    const events = await client.getEvents(bucketId, {
        start: start.toISOString(),
        end: end.toISOString()
    });

    const aggregate: IProjectAggregate = {
        totalEvents: 0,
        projects: {},
        languages: {},
        files: {},
        branches: {}
    };

    events.forEach((event: IEvent) => {
        const eventData = event.data as Record<string, unknown>;
        if (!isProjectEventData(eventData)) {
            return;
        }
        aggregate.totalEvents += 1;
        incrementCounter(aggregate.projects, eventData.project);
        incrementCounter(aggregate.languages, eventData.language);
        incrementCounter(aggregate.files, eventData.file);
        incrementCounter(aggregate.branches, eventData.branch || 'unknown');
    });

    const report: IReportOutput = {
        generatedAt: new Date().toISOString(),
        bucketId,
        start: start.toISOString(),
        end: end.toISOString(),
        aggregate
    };
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), { encoding: 'utf8' });
    console.log(`Project report saved to ${outputFile}`);
}

main().catch((err: Error) => {
    console.error('Failed to build project report:', err.message);
    process.exit(1);
});
