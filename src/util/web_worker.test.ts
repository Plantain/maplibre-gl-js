import {afterEach, describe, expect, test, vi} from 'vitest';
import {config} from './config';
import {workerFactory} from './web_worker';

describe('workerFactory', () => {
    afterEach(() => {
        config.WORKER_URL = '';
        vi.unstubAllGlobals();
    });

    test('creates blob workers as classic workers', () => {
        const WorkerMock = vi.fn();
        vi.stubGlobal('Worker', WorkerMock);
        config.WORKER_URL = 'blob:https://example.test/offline-worker';

        workerFactory();

        expect(WorkerMock).toHaveBeenCalledWith(config.WORKER_URL, undefined);
    });

    test('creates explicitly marked module workers as module workers', () => {
        const WorkerMock = vi.fn();
        vi.stubGlobal('Worker', WorkerMock);
        config.WORKER_URL = 'https://example.test/worker.js?type=module';

        workerFactory();

        expect(WorkerMock).toHaveBeenCalledWith(config.WORKER_URL, {type: 'module'});
    });
});
