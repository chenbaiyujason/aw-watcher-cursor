import * as fs from 'fs';
import * as path from 'path';
import { AWClient, IEvent } from '../aw-client-js/src/aw-client';

interface ICommitArchiveEventData {
    [key: string]: unknown;
    eventName: 'commit_summary';
    commitHashFull: string;
    project: string;
    repoPath: string;
    branch: string;
    subject: string;
    body: string;
    relatedAgentSessionId: string;
    commitDate: string;
}

interface ICommitIndexEntry {
    commitHashFull: string;
    project: string;
    repoPath: string;
    branch: string;
    subject: string;
    body: string;
    commitDate: string;
    relatedAgentSessionId: string;
}

interface ICommitReportOutput {
    generatedAt: string;
    bucketId: string;
    start: string;
    end: string;
    commitsByProject: { [project: string]: string[] };
    commitsByHash: { [commitHash: string]: ICommitIndexEntry };
    commitsByAgentSession: { [sessionId: string]: string[] };
}

function getArgValue(flag: string): string | undefined {
    const found = process.argv.find((item) => item.indexOf(`${flag}=`) === 0);
    return found ? found.split('=').slice(1).join('=') : undefined;
}

function isCommitArchiveEventData(data: object): data is ICommitArchiveEventData {
    const candidate = data as { [key: string]: unknown };
    return typeof candidate.eventName === 'string' && typeof candidate.commitHashFull === 'string';
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

function pushUnique(target: { [key: string]: string[] }, key: string, value: string): void {
    const safeKey = key || 'unknown';
    if (!target[safeKey]) {
        target[safeKey] = [];
    }
    if (target[safeKey].indexOf(value) === -1) {
        target[safeKey].push(value);
    }
}

async function main() {
    const hoursRaw = getArgValue('--hours');
    const outputFile = getArgValue('--output') || path.join(process.cwd(), 'commit-report.json');
    const hours = hoursRaw ? Number(hoursRaw) : 168;
    const end = new Date();
    const start = new Date(end.getTime() - hours * 60 * 60 * 1000);

    const client = new AWClient('aw-watcher-vscode-report');
    const bucketId = await findBucketId(client, 'app.editor.activity');
    const events = await client.getEvents(bucketId, {
        start: start.toISOString(),
        end: end.toISOString()
    });

    const commitsByHash: { [commitHash: string]: ICommitIndexEntry } = {};
    const commitsByProject: { [project: string]: string[] } = {};
    const commitsByAgentSession: { [sessionId: string]: string[] } = {};

    events.forEach((event: IEvent) => {
        if (!isCommitArchiveEventData(event.data)) {
            return;
        }
        const data = event.data;
        commitsByHash[data.commitHashFull] = {
            commitHashFull: data.commitHashFull,
            project: data.project || 'unknown',
            repoPath: data.repoPath || 'unknown',
            branch: data.branch || 'unknown',
            subject: data.subject || '',
            body: data.body || '',
            commitDate: data.commitDate || '',
            relatedAgentSessionId: data.relatedAgentSessionId || 'unknown'
        };
        pushUnique(commitsByProject, data.project || 'unknown', data.commitHashFull);
        pushUnique(commitsByAgentSession, data.relatedAgentSessionId || 'unknown', data.commitHashFull);
    });

    const report: ICommitReportOutput = {
        generatedAt: new Date().toISOString(),
        bucketId,
        start: start.toISOString(),
        end: end.toISOString(),
        commitsByProject,
        commitsByHash,
        commitsByAgentSession
    };

    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), { encoding: 'utf8' });
    console.log(`Commit report saved to ${outputFile}`);
}

main().catch((err: Error) => {
    console.error('Failed to build commit report:', err.message);
    process.exit(1);
});
