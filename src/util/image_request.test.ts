import {describe, beforeEach, afterEach, onTestFinished, test, expect, vi} from 'vitest';
import {config} from './config.ts';
import {sleep, stubAjaxGetImage} from './test/util.ts';
import {fakeServer, type FakeServer} from 'nise';
import {ImageRequest, type ImageRequestSchedulingOptions} from './image_request.ts';
import {isAbortError} from './abort_error.ts';
import * as ajax from './ajax.ts';
import * as util from './util.ts';
import * as jxlSupport from './jxl_supported.ts';
import {addProtocol, removeProtocol} from '../source/protocol_crud.ts';

/** Mock fetch and expose the prototype signal that ajax.ts uses to detect fetch support in jsdom. */
function mockFetch() {
    if (!Object.hasOwn(Request.prototype, 'signal')) {
        Object.defineProperty(Request.prototype, 'signal', {value: undefined, configurable: true});
        onTestFinished(() => { Reflect.deleteProperty(Request.prototype, 'signal'); });
    }
    global.fetch = vi.fn().mockResolvedValue(new Response(new ArrayBuffer(0)));
}

describe('ImageRequest', () => {
    let server: FakeServer;
    beforeEach(() => {
        global.fetch = null;
        server = fakeServer.create();
        ImageRequest.resetRequestQueue();
        stubAjaxGetImage(undefined);
    });
    afterEach(() => {
        server.restore();
        vi.restoreAllMocks();
    });

    test('getImage respects maxParallelImageRequests', async () => {
        server.respondWith(request => { request.respond(200, {'Content-Type': 'image/png'}, ''); });

        const maxRequests = config.MAX_PARALLEL_IMAGE_REQUESTS;

        const promises: Array<Promise<any>> = [];
        for (let i = 0; i < maxRequests + 5; i++) {
            promises.push(ImageRequest.getImage({url: ''}, new AbortController()));

        }
        expect(server.requests).toHaveLength(maxRequests);

        server.requests[0].respond(200);
        await promises[0];
        expect(server.requests).toHaveLength(maxRequests + 1);
        server.requests[1].respond(200);
        await promises[1];
        expect(server.requests).toHaveLength(maxRequests + 2);
    });

    test('current images overtake queued preloads while preserving FIFO within each priority', async () => {
        const preload: ImageRequestSchedulingOptions = {getPriority: () => 'preload'};
        for (let i = 0; i < config.MAX_PARALLEL_IMAGE_REQUESTS; i++) {
            ImageRequest.getImage({url: `active-${i}`}, new AbortController()).catch(() => {});
        }
        const pending = [
            ImageRequest.getImage({url: 'preload-1'}, new AbortController(), true, undefined, preload),
            ImageRequest.getImage({url: 'preload-2'}, new AbortController(), true, undefined, preload),
            ImageRequest.getImage({url: 'current-1'}, new AbortController()),
            ImageRequest.getImage({url: 'current-2'}, new AbortController())
        ];

        for (let i = 0; i < 4; i++) {
            server.requests[i].respond(200);
            await sleep(0);
        }
        expect(server.requests.slice(config.MAX_PARALLEL_IMAGE_REQUESTS).map(request => request.url))
            .toEqual(['current-1', 'current-2', 'preload-1', 'preload-2']);
        for (const request of server.requests.slice(config.MAX_PARALLEL_IMAGE_REQUESTS)) request.respond(200);
        await Promise.all(pending);
    });

    test('preloads use at most two slots and current images can use the remaining capacity', async () => {
        const preload: ImageRequestSchedulingOptions = {getPriority: () => 'preload'};
        const pending = [];
        for (let i = 0; i < 5; i++) {
            pending.push(ImageRequest.getImage({url: `preload-${i}`}, new AbortController(), true, undefined, preload));
        }
        expect(server.requests).toHaveLength(2);
        for (let i = 0; i < config.MAX_PARALLEL_IMAGE_REQUESTS; i++) {
            pending.push(ImageRequest.getImage({url: `current-${i}`}, new AbortController()));
        }
        expect(server.requests).toHaveLength(config.MAX_PARALLEL_IMAGE_REQUESTS);
        server.requests[0].respond(200);
        await sleep(0);
        expect(server.requests.at(-1).url).toBe(`current-${config.MAX_PARALLEL_IMAGE_REQUESTS - 2}`);
        server.requests[1].respond(200);
        await sleep(0);
        expect(server.requests.at(-1).url).toBe(`current-${config.MAX_PARALLEL_IMAGE_REQUESTS - 1}`);
        // Drain both priorities, including preloads started by completions.
        for (let i = 2; i < pending.length; i++) {
            server.requests[i].respond(200);
            await sleep(0);
        }
        await Promise.all(pending);
    });

    test('promoting a source immediately updates queued and running requests without refetching', async () => {
        let priority: 'normal' | 'preload' = 'preload';
        const scheduling: ImageRequestSchedulingOptions = {getPriority: () => priority};
        const pending = [];
        for (let i = 0; i < 5; i++) {
            pending.push(ImageRequest.getImage({url: `selected-${i}`}, new AbortController(), true, undefined, scheduling));
        }
        expect(server.requests).toHaveLength(2);
        priority = 'normal';
        ImageRequest.processQueue();
        expect(server.requests.map(request => request.url)).toEqual([
            'selected-0', 'selected-1', 'selected-2', 'selected-3', 'selected-4'
        ]);

        // Promoted in-flight requests no longer consume the preload allowance.
        const next = {getPriority: () => 'preload' as const};
        pending.push(ImageRequest.getImage({url: 'next-0'}, new AbortController(), true, undefined, next));
        pending.push(ImageRequest.getImage({url: 'next-1'}, new AbortController(), true, undefined, next));
        expect(server.requests).toHaveLength(7);
        for (const request of server.requests) request.respond(200);
        await Promise.all(pending);
    });

    test('paused preloads do not occupy slots or block current images and resume when reconsidered', async () => {
        let moving = true;
        const scheduling: ImageRequestSchedulingOptions = {
            getPriority: () => 'preload',
            isPaused: () => moving
        };
        const preload = ImageRequest.getImage({url: 'next'}, new AbortController(), true, undefined, scheduling);
        const current = ImageRequest.getImage({url: 'current'}, new AbortController());
        expect(server.requests.map(request => request.url)).toEqual(['current']);
        server.requests[0].respond(200);
        await current;
        expect(server.requests).toHaveLength(1);
        moving = false;
        ImageRequest.processQueue();
        expect(server.requests.map(request => request.url)).toEqual(['current', 'next']);
        server.requests[1].respond(200);
        await preload;
    });

    test('cancelled paused preloads settle immediately and are never dispatched', async () => {
        const controller = new AbortController();
        const scheduling: ImageRequestSchedulingOptions = {getPriority: () => 'preload', isPaused: () => true};
        const pending = ImageRequest.getImage({url: 'obsolete'}, controller, true, undefined, scheduling);
        const rejected = pending.catch(error => error);
        controller.abort();
        expect(isAbortError(await rejected)).toBe(true);
        ImageRequest.processQueue();
        expect(server.requests).toHaveLength(0);
    });

    test('already aborted requests reject without entering the queue', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(ImageRequest.getImage({url: 'obsolete'}, controller)).rejects.toSatisfy(isAbortError);
        expect(server.requests).toHaveLength(0);
    });

    test('preload completions and failures release capacity for subsequent preloads', async () => {
        const scheduling: ImageRequestSchedulingOptions = {getPriority: () => 'preload'};
        const pending = ['next-0', 'next-1', 'next-2', 'next-3'].map(url =>
            ImageRequest.getImage({url}, new AbortController(), true, undefined, scheduling).catch(() => null));
        expect(server.requests).toHaveLength(2);
        server.requests[0].respond(404);
        await pending[0];
        expect(server.requests).toHaveLength(3);
        server.requests[1].respond(200);
        await pending[1];
        expect(server.requests).toHaveLength(4);
        for (const request of server.requests.slice(2)) request.respond(200);
        await Promise.all(pending);
    });

    test('getImage uses createImageBitmap when premultiplyAlpha none is requested and supported', async () => {
        server.respondWith(request => request.respond(200, {'Content-Type': 'image/webp',
            'Cache-Control': 'cache',
            'Expires': 'expires'}, '0'));

        const imageBitmap = {} as ImageBitmap;
        const createImageBitmapSpy = vi.fn().mockResolvedValue(imageBitmap);
        stubAjaxGetImage(createImageBitmapSpy);

        const options = {premultiplyAlpha: 'none'} as const;
        const promise = ImageRequest.getImage({url: ''}, new AbortController(), true, options);
        server.respond();

        const response = await promise;
        expect(response.data).toBe(imageBitmap);
        expect(createImageBitmapSpy).toHaveBeenCalled();
        expect(jxlSupport.isJXLSupported).toHaveBeenCalledWith(true);
    });

    test('getImage uses HTMLImageElement on Safari when premultiplyAlpha none is requested', async () => {
        server.respondWith(request => request.respond(200, {'Content-Type': 'image/webp',
            'Cache-Control': 'cache',
            'Expires': 'expires'}, '0'));

        const createImageBitmapSpy = vi.fn().mockResolvedValue({});
        stubAjaxGetImage(createImageBitmapSpy);
        const isSafariSpy = vi.spyOn(util, 'isSafari').mockReturnValue(true);

        const options = {premultiplyAlpha: 'none'} as const;
        const promise = ImageRequest.getImage({url: ''}, new AbortController(), true, options);
        server.respond();

        const response = await promise;
        expect(response.data).toBeInstanceOf(HTMLImageElement);
        expect(createImageBitmapSpy).not.toHaveBeenCalled();
        expect(jxlSupport.isJXLSupported).toHaveBeenCalledWith(false);

        isSafariSpy.mockRestore();
    });

    test('getImage respects maxParallelImageRequests and continues to respond even when server returns 404', async () => {
        server.respondWith(request => { request.respond(404); });

        const maxRequests = config.MAX_PARALLEL_IMAGE_REQUESTS;

        for (let i = 0; i < maxRequests + 5; i++) {
            ImageRequest.getImage({url: ''}, new AbortController()).catch(() => {});
        }
        expect(server.requests).toHaveLength(maxRequests);
        server.respond();
        await sleep(0);
        expect(server.requests).toHaveLength(maxRequests + 5);
    });

    test('Cancel: getImage cancelling frees up request for maxParallelImageRequests', async () => {
        const maxRequests = config.MAX_PARALLEL_IMAGE_REQUESTS;

        for (let i = 0; i < maxRequests + 1; i++) {
            const abortController = new AbortController();
            const request = ImageRequest.getImage({url: ''}, abortController);
            abortController.abort();
            await expect(request).rejects.toSatisfy(isAbortError);
            await sleep(0);
        }
        expect(server.requests).toHaveLength(maxRequests + 1);
    });

    test('Cancel: getImage requests that were once queued are still abortable', async () => {
        const maxRequests = config.MAX_PARALLEL_IMAGE_REQUESTS;

        const abortControllers: AbortController[] = [];
        for (let i = 0; i < maxRequests; i++) {
            const abortController = new AbortController();
            abortControllers.push(abortController);
            ImageRequest.getImage({url: ''}, abortController).catch(() => {});
        }

        // the limit of allowed requests is reached
        expect(server.requests).toHaveLength(maxRequests);

        const queuedURL = 'this-is-the-queued-request';
        const abortController = new AbortController();
        const queuedRequestPromise = ImageRequest.getImage({url: queuedURL}, abortController);

        // the new requests is queued because the limit is reached
        expect(server.requests).toHaveLength(maxRequests);

        // cancel the first request to let the queued request start
        abortControllers[0].abort();
        await sleep(0);
        expect(server.requests).toHaveLength(maxRequests + 1);

        // abort the previously queued request and confirm that it is aborted
        const queuedRequest = server.requests[server.requests.length - 1];
        expect(queuedRequest.url).toBe(queuedURL);
        expect((queuedRequest as any).aborted).toBeUndefined();
        abortController.abort();
        expect((queuedRequest as any).aborted).toBe(true);
        await expect(queuedRequestPromise).rejects.toSatisfy(isAbortError);
    });

    test('getImage sends accept/webp header', async () => {
        server.respondWith((request) => {
            expect(request.requestHeaders.accept).toContain('image/webp');
            request.respond(200, {'Content-Type': 'image/webp'}, '');
        });

        const promise = ImageRequest.getImage({url: ''}, new AbortController());

        server.respond();

        await expect(promise).resolves.toBeDefined();
    });

    test('getImage uses createImageBitmap when supported', async () => {
        server.respondWith(request => { request.respond(200, {'Content-Type': 'image/png',
            'Cache-Control': 'cache',
            'Expires': 'expires'}, '0'); });

        const createImageBitmapSpy = vi.fn().mockResolvedValue(new ImageBitmap());
        stubAjaxGetImage(createImageBitmapSpy);
        const options = {premultiplyAlpha: 'none'} as const;
        const promise = ImageRequest.getImage({url: ''}, new AbortController(), true, options);
        server.respond();

        const response = await promise;

        expect(response.data).toBeInstanceOf(ImageBitmap);
        expect(response.cacheControl).toBe('cache');
        expect(response.expires).toBe('expires');
        expect(createImageBitmapSpy).toHaveBeenCalledWith(expect.any(Blob), options);
    });

    test('getImage resolves an empty response (e.g. HTTP 204) with null data and keeps the expiry headers', async () => {
        server.respondWith(request => { request.respond(200, {'Content-Type': 'image/png',
            'Cache-Control': 'cache',
            'Expires': 'expires'}, ''); });

        const createImageBitmapSpy = vi.fn();
        stubAjaxGetImage(createImageBitmapSpy);
        const promise = ImageRequest.getImage({url: ''}, new AbortController());
        server.respond();

        const response = await promise;

        expect(response.data).toBeNull();
        expect(response.cacheControl).toBe('cache');
        expect(response.expires).toBe('expires');
        expect(createImageBitmapSpy).not.toHaveBeenCalled();
    });

    test('getImage using createImageBitmap throws exception', async () => {
        server.respondWith(request => { request.respond(200, {'Content-Type': 'image/png',
            'Cache-Control': 'cache',
            'Expires': 'expires'}, '0'); });

        stubAjaxGetImage(() => Promise.reject(new Error('error')));

        const promise = ImageRequest.getImage({url: ''}, new AbortController());

        server.respond();

        await expect(promise).rejects.toThrow('error');
    });

    test('getImage uses HTMLImageElement when createImageBitmap is not supported', async () => {
        const makeRequestSky = vi.spyOn(ajax, 'makeRequest');
        server.respondWith(request => { request.respond(200, {'Content-Type': 'image/png',
            'Cache-Control': 'cache',
            'Expires': 'expires'}, '0'); });

        const promise = ImageRequest.getImage({url: ''}, new AbortController());

        server.respond();
        expect(makeRequestSky).toHaveBeenCalledTimes(1);
        makeRequestSky.mockClear();
        const response = await promise;
        expect(response.data).toBeInstanceOf(HTMLImageElement);
        expect(response.cacheControl).toBe('cache');
        expect(response.expires).toBe('expires');
    });

    test('getImage using HTMLImageElement with same-origin credentials', async () => {
        const makeRequestSky = vi.spyOn(ajax, 'makeRequest');
        const promise = ImageRequest.getImage({url: '', credentials: 'same-origin'}, new AbortController(), false);

        expect(makeRequestSky).toHaveBeenCalledTimes(0);
        makeRequestSky.mockClear();

        const response = await promise;

        expect(response.data).toBeInstanceOf(HTMLImageElement);
        expect((response.data as HTMLImageElement).crossOrigin).toBe('anonymous');
    });

    test('getImage using HTMLImageElement with include credentials', async () => {
        const makeRequestSky = vi.spyOn(ajax, 'makeRequest');
        const promise = ImageRequest.getImage({url: '', credentials: 'include'}, new AbortController(), false);

        expect(makeRequestSky).toHaveBeenCalledTimes(0);
        makeRequestSky.mockClear();

        const response = await promise;

        expect(response.data).toBeInstanceOf(HTMLImageElement);
        expect((response.data as HTMLImageElement).crossOrigin).toBe('use-credentials');
    });

    test.each(['accept', 'Accept', 'ACCEPT'])('sends an explicit %s header through makeRequest', async (name) => {
        const makeRequestSpy = vi.spyOn(ajax, 'makeRequest');
        const promise = ImageRequest.getImage({url: '', headers: {[name]: 'image/png'}}, new AbortController(), false);
        expect(makeRequestSpy).toHaveBeenCalledTimes(1);
        expect(jxlSupport.isJXLSupported).not.toHaveBeenCalled();
        expect(server.requests[0].requestHeaders[name]).toBe('image/png');
        server.requests[0].respond(200);
        await expect(promise).resolves.toBeDefined();
    });

    test.each([true, false])('sends a detected Accept header with JXL support = %s', async (supported) => {
        vi.mocked(jxlSupport.isJXLSupported).mockResolvedValue(supported);
        const promise = ImageRequest.getImage({url: ''}, new AbortController());
        expect(server.requests).toHaveLength(0);
        await sleep(0);
        expect(server.requests[0].requestHeaders.accept).toBe(supported ? 'image/jxl,image/webp,*/*' : 'image/webp,*/*');
        server.requests[0].respond(200);
        await expect(promise).resolves.toBeDefined();
    });

    test.each([true, false])('fetch sends the detected header with JXL support = %s', async (supported) => {
        vi.mocked(jxlSupport.isJXLSupported).mockResolvedValue(supported);
        mockFetch();
        await ImageRequest.getImage({url: 'http://localhost/image'}, new AbortController());
        const request = vi.mocked(fetch).mock.calls[0][0] as Request;
        expect(request.headers.get('Accept')).toBe(supported ? 'image/jxl,image/webp,*/*' : 'image/webp,*/*');
    });

    test.each([
        {headers: {Accept: 'image/png'}},
        {headers: new Headers({accept: 'image/png'})},
        {headers: [['ACCEPT', 'image/png']]}
    ])('preserves fetch Accept overrides in supported header representations: %j', async ({headers}) => {
        mockFetch();
        await ImageRequest.getImage({url: 'http://localhost/image', headers}, new AbortController(), false);
        const request = vi.mocked(fetch).mock.calls[0][0] as Request;
        expect(request.headers.get('Accept')).toBe('image/png');
        expect(jxlSupport.isJXLSupported).not.toHaveBeenCalled();
    });

    test('native image requests bypass detection and do not add headers to caller parameters', async () => {
        const parameters = {url: ''};
        await ImageRequest.getImage(parameters, new AbortController(), false);
        expect(jxlSupport.isJXLSupported).not.toHaveBeenCalled();
        expect(parameters).toEqual({url: ''});
        expect(server.requests).toHaveLength(0);
    });

    test('generated headers do not affect later requests reusing the same parameters', async () => {
        const parameters = {url: '', headers: {}};
        const first = ImageRequest.getImage(parameters, new AbortController());
        server.requests[0].respond(200);
        await first;
        await ImageRequest.getImage(parameters, new AbortController(), false);
        expect(parameters.headers).toEqual({});
        expect(server.requests).toHaveLength(1);
    });

    test('canceling during detection releases a queue slot without canceling shared detection', async () => {
        let finishDetection: (supported: boolean) => void;
        const detection = new Promise<boolean>(resolve => { finishDetection = resolve; });
        vi.mocked(jxlSupport.isJXLSupported).mockReturnValue(detection);
        const controller = new AbortController();
        const canceled = ImageRequest.getImage({url: 'canceled'}, controller);
        const others = Array.from({length: config.MAX_PARALLEL_IMAGE_REQUESTS}, (_, i) =>
            ImageRequest.getImage({url: `image-${i}`}, new AbortController()));
        expect(jxlSupport.isJXLSupported).toHaveBeenCalledTimes(config.MAX_PARALLEL_IMAGE_REQUESTS);
        controller.abort();
        await expect(canceled).rejects.toSatisfy(isAbortError);
        expect(jxlSupport.isJXLSupported).toHaveBeenCalledTimes(config.MAX_PARALLEL_IMAGE_REQUESTS + 1);
        expect(server.requests).toHaveLength(0);
        finishDetection(true);
        await sleep(0);
        expect(server.requests).toHaveLength(config.MAX_PARALLEL_IMAGE_REQUESTS);
        for (const request of server.requests) {
            expect(request.url).not.toBe('canceled');
            expect(request.requestHeaders.accept).toContain('image/jxl');
            request.respond(200);
        }
        await Promise.all(others);
    });

    test('custom protocols receive detected headers and retain cache metadata', async () => {
        vi.mocked(jxlSupport.isJXLSupported).mockResolvedValue(true);
        const handler = vi.fn().mockResolvedValue({data: new ArrayBuffer(0), cacheControl: 'max-age=60', expires: 'expiry'});
        addProtocol('jxl-test', handler);
        try {
            const response = await ImageRequest.getImage({url: 'jxl-test://image'}, new AbortController(), false);
            expect(handler.mock.calls[0][0].headers.accept).toBe('image/jxl,image/webp,*/*');
            expect(response.cacheControl).toBe('max-age=60');
            expect(response.expires).toBe('expiry');
        } finally {
            removeProtocol('jxl-test');
        }
    });

    test('getImage uses makeRequest when custom Headers are added', () => {
        const makeRequestSky = vi.spyOn(ajax, 'makeRequest');

        ImageRequest.getImage({url: '', credentials: 'include', headers: {custom: 'test', accept: 'image'}}, new AbortController(), false);

        expect(makeRequestSky).toHaveBeenCalledTimes(1);
        makeRequestSky.mockClear();
    });

    test('getImage uses makeRequest when imageBitmapOptions are set', async () => {
        const makeRequestSky = vi.spyOn(ajax, 'makeRequest');
        server.respondWith(request => request.respond(200, {'Content-Type': 'image/png'}, '0'));

        const promise = ImageRequest.getImage({url: ''}, new AbortController(), false, {premultiplyAlpha: 'none'});

        expect(makeRequestSky).toHaveBeenCalledTimes(1);
        server.respond();
        await expect(promise).resolves.toBeDefined();
    });

    test('getImage request returned 404 response for fetch request', async () => {
        server.respondWith(request => { request.respond(404); });

        const promise = ImageRequest.getImage({url: ''}, new AbortController());

        server.respond();

        await expect(promise).rejects.toThrow('Not Found');
    });

    test('getImage request failed for HTTPImageRequest', async () => {
        const promise = ImageRequest.getImage({url: 'error'},  new AbortController(), false);
        await expect(promise).rejects.toThrow(/Could not load image.*/);
    });

    test('Cancel: getImage request cancelled for HTTPImageRequest', async () => {
        let imageUrl;
        const requestUrl = 'test';
        Object.defineProperty(global.Image.prototype, 'src', {
            set(url: string) {
                imageUrl = url;
            }
        });

        const abortController = new AbortController();
        ImageRequest.getImage({url: requestUrl}, abortController, false).catch(() => {});

        expect(imageUrl).toBe(requestUrl);
        expect(abortController.signal.aborted).toBeFalsy();
        abortController.abort();
        expect(abortController.signal.aborted).toBeTruthy();
        expect(imageUrl).toBe('');
    });

    test('Cancel: getImage request cancelled', async () => {
        server.respondWith(request => { request.respond(200, {'Content-Type': 'image/png',
            'Cache-Control': 'cache',
            'Expires': 'expires'}, ''); });

        const abortController = new AbortController();
        let response = false;
        ImageRequest.getImage({url: ''}, abortController)
            .then(() => response = true)
            .catch(() => response = true);

        abortController.abort();

        server.respond();

        expect(response).toBeFalsy();
    });

    test('Cancel: Cancellation of an image which has not yet been requested', async () => {
        const maxRequests = config.MAX_PARALLEL_IMAGE_REQUESTS;

        let callbackCounter = 0;
        const promiseCallback = () => callbackCounter++;

        const abortConstollers: Array<{url: string; abortController: AbortController}> = [];
        for (let i = 0; i < maxRequests + 100; i++) {
            const url = `${i}`;
            const abortController = new AbortController();
            abortConstollers.push({url, abortController});
            ImageRequest.getImage({url}, abortController).then(promiseCallback).catch(() => {});
        }

        abortConstollers[0].abortController.abort();
        await sleep(0);
        // Queue should move forward and next request is made
        expect(server.requests).toHaveLength(maxRequests + 1);

        // Cancel request should not call callback
        expect(callbackCounter).toBe(0);

        // Cancel request which is not yet issued. It should not fire callback
        const nextRequestInQueue = abortConstollers[server.requests.length];
        const cancelledImageUrl = nextRequestInQueue.url;
        nextRequestInQueue.abortController.abort();

        // Queue should not move forward as cancelled image was sitting in queue
        expect(server.requests).toHaveLength(maxRequests + 1);
        expect(callbackCounter).toBe(0);

        // On server response, next image queued should not be the cancelled image
        server.requests[1].respond(200);
        await sleep(0);
        expect(callbackCounter).toBe(1);
        expect(server.requests).toHaveLength(maxRequests + 2);
        // Verify that the last request made skipped the cancelled image request
        expect(server.requests[server.requests.length - 1].url).toBe((parseInt(cancelledImageUrl) + 1).toString());
    });

    test('throttling: one throttling client will result in throttle behavior for all', () => {
        const maxRequestsPerFrame = config.MAX_PARALLEL_IMAGE_REQUESTS_PER_FRAME;
        const callbackHandles = [];

        // add one for each
        callbackHandles.push(ImageRequest.addThrottleControl(() => false));
        callbackHandles.push(ImageRequest.addThrottleControl(() => true));

        let callbackCounter = 0;
        const promiseCallback = () => callbackCounter++;

        for (let i = 0; i < maxRequestsPerFrame + 1; i++) {
            ImageRequest.getImage({url: ''}, new AbortController()).then(promiseCallback);
        }

        expect(server.requests).toHaveLength(maxRequestsPerFrame);

        // all pending
        expect(callbackCounter).toBe(0);

        for (const handle of callbackHandles) {
            ImageRequest.removeThrottleControl(handle);
        }
    });

    test('throttling: image queue will process MAX_PARALLEL_IMAGE_REQUESTS_PER_FRAME if throttling control returns true', () => {
        const maxRequestsPerFrame = config.MAX_PARALLEL_IMAGE_REQUESTS_PER_FRAME;
        const maxRequests = config.MAX_PARALLEL_IMAGE_REQUESTS;
        const controlId = ImageRequest.addThrottleControl(() => true);

        let callbackCounter = 0;
        const promiseCallback = () => callbackCounter++;

        for (let i = 0; i < maxRequests; i++) {
            ImageRequest.getImage({url: ''}, new AbortController()).then(promiseCallback);
        }

        // Should only fire request to a max allowed per frame
        expect(server.requests).toHaveLength(maxRequestsPerFrame);

        // all pending
        expect(callbackCounter).toBe(0);

        ImageRequest.removeThrottleControl(controlId);
    });

    test('throttling: image queue will process MAX_PARALLEL_IMAGE_REQUESTS if throttling control returns false', () => {
        const maxRequests = config.MAX_PARALLEL_IMAGE_REQUESTS;
        const controlId = ImageRequest.addThrottleControl(() => false);

        let callbackCounter = 0;
        const promiseCallback = () => callbackCounter++;

        for (let i = 0; i < maxRequests + 100; i++) {
            ImageRequest.getImage({url: ''}, new AbortController()).then(promiseCallback);
        }

        // all should be processed because throttle control is returning false
        expect(server.requests).toHaveLength(maxRequests);

        // all pending
        expect(callbackCounter).toBe(0);

        ImageRequest.removeThrottleControl(controlId);
    });

    test('throttling: removing throttling client will process all requests', async () => {
        const requestParameter = {'Content-Type': 'image/png', url: ''};
        const maxRequestsPerFrame = config.MAX_PARALLEL_IMAGE_REQUESTS_PER_FRAME;

        // add 10, and one of them is throttling
        const throttlingIndex = 5;
        for (let i = 0; i < 10; i++) {
            const throttlingClient: boolean = (i === throttlingIndex);
            ImageRequest.addThrottleControl(() => throttlingClient);
        }

        // make 2 times + 1 more requests
        const requestsMade = 2 * maxRequestsPerFrame + 1;
        const completedMap: {[index: number]: boolean} = {};
        for (let i = 0; i < requestsMade; i++) {
            const promise = ImageRequest.getImage(requestParameter, new AbortController());
            promise.catch(() => {});
            promise.then(() => completedMap[i] = true);
        }

        // up to the config value
        expect(server.requests).toHaveLength(maxRequestsPerFrame);

        const itemIndexToComplete = 6;
        server.requests[itemIndexToComplete].respond(200);

        // unleash it by removing the throttling client
        ImageRequest.removeThrottleControl(throttlingIndex);
        await sleep(0);
        expect(server.requests).toHaveLength(requestsMade);

        // all pending
        expect(Object.keys(completedMap)).toHaveLength(1);

        // everything should still be pending except itemIndexToComplete
        for (let i = 0; i < maxRequestsPerFrame + 1; i++) {
            expect(completedMap[i]).toBe(i === itemIndexToComplete ? true : undefined);
        }
    });
});
