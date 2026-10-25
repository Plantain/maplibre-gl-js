import {type RequestParameters, makeRequest, sameOrigin, type GetResourceResponse} from './ajax.ts';
import {arrayBufferToImageBitmap, arrayBufferToImage, isWorker, isImageBitmap, isSafari, ensureError} from './util.ts';
import {isJXLSupported} from './jxl_supported.ts';
import {config} from './config.ts';
import {AbortError, throwIfAborted} from './abort_error.ts';
import {getProtocol} from '../source/protocol_crud.ts';

import type {RequestManager, ResourceType} from './request_manager.ts';

type ImageQueueThrottleControlCallback = () => boolean;

export type ImageRequestPriority = 'normal' | 'preload';

/** Source-owned callbacks let queued and running requests follow priority changes. */
export type ImageRequestSchedulingOptions = {
    getPriority: () => ImageRequestPriority;
    isPaused?: () => boolean;
};

export type ImageRequestQueueItem  = {
    requestParameters: RequestParameters;
    supportImageRefresh: boolean;
    imageBitmapOptions?: ImageBitmapOptions;
    schedulingOptions?: ImageRequestSchedulingOptions;
    state: 'queued' | 'running' | 'completed';
    abortController: AbortController;
    onError: (error: Error) => void;
    onSuccess: (response: GetResourceResponse<HTMLImageElement | ImageBitmap | null>) => void;
    onAbort: () => void;
};

type ImageQueueThrottleCallbackDictionary = Record<number, ImageQueueThrottleControlCallback>;

type HTMLImageElementWithPriority = HTMLImageElement &
{
    // fetchPriority is experimental property supported on Chromium browsers from Version 102
    // By default images are downloaded with priority low, whereas fetch request downloads with priority high
    // https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/fetchPriority
    fetchPriority?: 'auto' | 'high' | 'low';
};

/**
 * By default, the image queue is self driven, meaning as soon as one requested item is processed,
 * it will move on to next one as quickly as it can while limiting
 * the number of concurrent requests to MAX_PARALLEL_IMAGE_REQUESTS. The default behavior
 * ensures that static views of the map can be rendered with minimal delay.
 *
 * However, the default behavior can prevent dynamic views of the map from rendering
 * smoothly in that many requests can finish in one render frame, putting too much pressure on GPU.
 *
 * When the view of the map is moving dynamically, smoother frame rates can be achieved
 * by throttling the number of items processed by the queue per frame. This can be
 * accomplished by using {@link addThrottleControl} to allow the caller to
 * use a lambda function to determine when the queue should be throttled (e.g. when isMoving())
 * and manually calling {@link processQueue} in the render loop.
 */
export namespace ImageRequest {
    let imageRequestQueue : ImageRequestQueueItem[];
    let activeImageRequests: Set<ImageRequestQueueItem>;

    let throttleControlCallbackHandleCounter: number;
    let throttleControlCallbacks: ImageQueueThrottleCallbackDictionary;

    /**
     * Reset the image request queue, removing all pending requests.
     */
    export const resetRequestQueue = (): void => {
        for (const request of imageRequestQueue || []) {
            request.abortController.signal.removeEventListener('abort', request.onAbort);
        }
        imageRequestQueue = [];
        activeImageRequests = new Set();
        throttleControlCallbackHandleCounter = 0;
        throttleControlCallbacks = {};
    };

    /**
     * Install a callback to control when image queue throttling is desired.
     * (e.g. when the map view is moving)
     * @param callback - The callback function to install
     * @returns handle that identifies the installed callback.
     */
    export const addThrottleControl = (callback: ImageQueueThrottleControlCallback): number => {
        const handle = throttleControlCallbackHandleCounter++;
        throttleControlCallbacks[handle] = callback;
        return handle;
    };

    /**
     * Remove a previously installed callback by passing in the handle returned
     * by {@link addThrottleControl}.
     * @param callbackHandle - The handle for the callback to remove.
     */
    export const removeThrottleControl = (callbackHandle: number): void => {
        delete throttleControlCallbacks[callbackHandle];
        // Try updating the queue
        processQueue();
    };

    /**
     * Check to see if any of the installed callbacks are requesting the queue
     * to be throttled.
     * @returns `true` if any callback is causing the queue to be throttled.
     */
    const isThrottled = (): boolean => {
        for (const key of Object.keys(throttleControlCallbacks)) {
            if (throttleControlCallbacks[key]()) {
                return true;
            }
        }
        return false;
    };

    /**
     * Transform `url` through {@link RequestManager.transformRequest} and load the image.
     * The transform may be async; if `abortController` aborts while it is pending, the
     * request is never issued and the returned promise rejects with an `AbortError`.
     * @param requestManager - The request manager whose transform to apply.
     * @param url - The image URL, before transformation.
     * @param resourceType - The resource type to pass to the transform.
     * @param abortController - allows to abort the request.
     * @param supportImageRefresh - `true`, if the image request need to support refresh based on cache headers.
     * @param imageBitmapOptions - Options for `createImageBitmap`. Pass `{colorSpaceConversion: 'none'}` for images
     * whose pixels hold data rather than color, such as raster-DEM tiles, so the browser does not color manage them.
     * @param schedulingOptions - Dynamic source priority and pause state for forecast preloads.
     * @returns - A promise resolved when the image is loaded.
     */
    export async function transformAndGetImage(
        requestManager: RequestManager,
        url: string,
        resourceType: ResourceType,
        abortController: AbortController,
        supportImageRefresh: boolean = true,
        imageBitmapOptions?: ImageBitmapOptions,
        schedulingOptions?: ImageRequestSchedulingOptions
    ): Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>> {
        const requestParameters = await requestManager.transformRequest(url, resourceType);
        throwIfAborted(abortController.signal);
        return ImageRequest.getImage(requestParameters, abortController, supportImageRefresh, imageBitmapOptions, schedulingOptions);
    }

    /**
     * Request to load an image.
     * Generated headers are kept separate from caller-provided headers so parameters can be reused.
     * @param requestParameters - Request parameters.
     * @param abortController - allows to abort the request.
     * @param supportImageRefresh - `true`, if the image request need to support refresh based on cache headers.
     * @param schedulingOptions - Dynamic source priority and pause state for forecast preloads.
     * @returns - A promise resolved when the image is loaded.
     */
    export function getImage(
        requestParameters: RequestParameters,
        abortController: AbortController,
        supportImageRefresh: boolean = true,
        imageBitmapOptions?: ImageBitmapOptions,
        schedulingOptions?: ImageRequestSchedulingOptions
    ): Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>> {
        return new Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>>((resolve, reject) => {
            if (abortController.signal.aborted) {
                reject(new AbortError());
                return;
            }
            const headers = requestParameters.headers;
            const request: ImageRequestQueueItem = {
                abortController,
                requestParameters: {
                    ...requestParameters,
                    type: 'image',
                    headers: headers instanceof Headers || Array.isArray(headers) ? Object.fromEntries(new Headers(headers)) : {...headers}
                },
                supportImageRefresh,
                imageBitmapOptions,
                schedulingOptions,
                state: 'queued',
                onError: (error: Error) => {
                    reject(error);
                },
                onSuccess: (response) => {
                    resolve(response);
                },
                onAbort: () => {
                    if (request.state !== 'queued') return;
                    const index = imageRequestQueue.indexOf(request);
                    if (index < 0) return;
                    imageRequestQueue.splice(index, 1);
                    request.state = 'completed';
                    abortController.signal.removeEventListener('abort', request.onAbort);
                    reject(new AbortError());
                    processQueue();
                }
            };

            imageRequestQueue.push(request);
            abortController.signal.addEventListener('abort', request.onAbort);
            processQueue();
        });
    }

    const shouldUseImageBitmap = (imageBitmapOptions?: ImageBitmapOptions): boolean => {
        const needsRawPixels = imageBitmapOptions?.premultiplyAlpha === 'none';
        const useSafariHtmlImageFallback = needsRawPixels && !isWorker(self) && isSafari(globalThis);
        return typeof createImageBitmap === 'function' && !useSafariHtmlImageFallback;
    };

    const arrayBufferToCanvasImageSource = (
        data: ArrayBuffer,
        contentType?: string | null,
        imageBitmapOptions?: ImageBitmapOptions
    ): Promise<HTMLImageElement | ImageBitmap | null> => {
        if (shouldUseImageBitmap(imageBitmapOptions)) {
            return arrayBufferToImageBitmap(data, imageBitmapOptions, contentType);
        }
        return arrayBufferToImage(data, contentType);
    };

    /** Wait for shared format detection without letting one request cancel the probe. */
    const waitForJXLSupport = (support: Promise<boolean>, signal: AbortSignal): Promise<boolean> => {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new AbortError());
                return;
            }
            const onAbort = () => reject(new AbortError());
            signal.addEventListener('abort', onAbort, {once: true});
            support.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        });
    };

    /** Loads and decodes a queued image; empty bodies resolve with null data and retain expiry metadata. */
    const doImageRequest = async (itemInQueue: ImageRequestQueueItem) => {
        itemInQueue.state = 'running';
        itemInQueue.abortController.signal.removeEventListener('abort', itemInQueue.onAbort);
        const {requestParameters, supportImageRefresh, imageBitmapOptions, onError, onSuccess, abortController} = itemInQueue;
        // - If refreshExpiredTiles is false, then we can use HTMLImageElement to download raster images.
        // - Fetch/XHR (via MakeRequest API) will be used to download images for following scenarios:
        //      1. Style image sprite will had a issue with HTMLImageElement as described
        //          here: https://github.com/mapbox/mapbox-gl-js/issues/1470
        //      2. If refreshExpiredTiles is true (default), then in order to read the image cache header,
        //          fetch/XHR request will be required
        // - For any special case handling like use of AddProtocol, worker initiated request or additional headers
        //      let makeRequest handle it.
        // - HtmlImageElement request automatically adds accept header for all the browser supported images
        const canUseHTMLImageElement = supportImageRefresh === false &&
            !imageBitmapOptions &&
            !isWorker(self) &&
            !getProtocol(requestParameters.url) &&
            Object.keys(requestParameters.headers).length === 0;

        activeImageRequests.add(itemInQueue);

        try {
            if (!canUseHTMLImageElement && !Object.keys(requestParameters.headers).some(key => key.toLowerCase() === 'accept')) {
                let supported = isJXLSupported(shouldUseImageBitmap(imageBitmapOptions));
                if (typeof supported !== 'boolean') {
                    supported = await waitForJXLSupport(supported, abortController.signal);
                }
                const fallback = 'image/webp,*/*';
                requestParameters.headers.accept = supported ? `image/jxl,${fallback}` : fallback;
            }
            if (abortController.signal.aborted) throw new AbortError();
            const response = await (canUseHTMLImageElement ?
                getImageUsingHtmlImage(requestParameters, abortController) :
                makeRequest(requestParameters, abortController));
            delete itemInQueue.abortController;
            if ((typeof HTMLImageElement !== 'undefined' && response.data instanceof HTMLImageElement) || isImageBitmap(response.data)) {
                // User using addProtocol can directly return HTMLImageElement/ImageBitmap type
                // If HtmlImageElement is used to get image then response type will be HTMLImageElement
                onSuccess(response);
            } else if (!response.data || response.data.byteLength === 0) {
                onSuccess({...response, data: null});
            } else {
                const img = await arrayBufferToCanvasImageSource(response.data, response.contentType, imageBitmapOptions);
                onSuccess({
                    data: img,
                    cacheControl: response.cacheControl,
                    expires: response.expires,
                    etag: response.etag,
                    contentType: response.contentType
                });
            }
        } catch (err) {
            delete itemInQueue.abortController;
            onError(ensureError(err));
        } finally {
            itemInQueue.state = 'completed';
            activeImageRequests.delete(itemInQueue);
            processQueue();
        }
    };

    const isPreload = (request: ImageRequestQueueItem): boolean =>
        request.schedulingOptions?.getPriority() === 'preload';

    /** Dispatches visible tiles first, preserving FIFO within each priority and limiting active preloads. */
    export const processQueue = (): void => {

        const maxImageRequests = isThrottled() ?
            config.MAX_PARALLEL_IMAGE_REQUESTS_PER_FRAME :
            config.MAX_PARALLEL_IMAGE_REQUESTS;

        // limit concurrent image loads to help with raster sources performance on big screens
        while (activeImageRequests.size < maxImageRequests && imageRequestQueue.length > 0) {
            // Preserve FIFO within each priority, while allowing newly visible
            // tiles to overtake speculative requests from the next forecast.
            let index = imageRequestQueue.findIndex(request => !isPreload(request));
            if (index < 0) {
                const activePreloads = Array.from(activeImageRequests).filter(isPreload).length;
                if (activePreloads >= config.MAX_PARALLEL_PRELOAD_IMAGE_REQUESTS) break;
                index = imageRequestQueue.findIndex(request => !request.schedulingOptions?.isPaused?.());
                if (index < 0) break;
            }
            const [topItemInQueue] = imageRequestQueue.splice(index, 1);
            doImageRequest(topItemInQueue);
        }
    };

    const getImageUsingHtmlImage = (requestParameters: RequestParameters, abortController: AbortController): Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>>  => {
        return new Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>>((resolve, reject) => {

            const image = new Image() as HTMLImageElementWithPriority;
            const url = requestParameters.url;
            const credentials = requestParameters.credentials;
            if (credentials && credentials === 'include') {
                image.crossOrigin = 'use-credentials';
            } else if ((credentials && credentials === 'same-origin') || !sameOrigin(url)) {
                image.crossOrigin = 'anonymous';
            }

            abortController.signal.addEventListener('abort', () => {
                // Set src to '' to actually cancel the request
                image.src = '';
                reject(new AbortError(abortController.signal.reason));
            });

            image.fetchPriority = 'high';
            image.onload = () => {
                image.onerror = image.onload = null;
                resolve({data: image});
            };
            image.onerror = () => {
                image.onerror = image.onload = null;
                if (abortController.signal.aborted) {
                    return;
                }
                reject(new Error('Could not load image. Please make sure to use a supported image type such as PNG or JPEG. Note that SVGs are not supported.'));
            };
            image.src = url;
        });
    };
}

ImageRequest.resetRequestQueue();
