import {describe, beforeEach, afterEach, test, expect, vi} from 'vitest';
import {MercatorProjection} from '../geo/projection/mercator_projection.ts';
import {RasterTileSource} from './raster_tile_source.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {RequestManager} from '../util/request_manager.ts';
import {fakeServer, type FakeServer} from 'nise';
import {sleep, stubAjaxGetImage, waitForEvent} from '../util/test/util.ts';
import {ImageRequest} from '../util/image_request.ts';
import {Context} from '../webgl/context.ts';
import {createNullGL} from '../util/test/null_gl.ts';

import type {Dispatcher} from '../util/dispatcher.ts';
import type {Tile} from '../tile/tile.ts';
import type {MapSourceDataEvent} from '../ui/events.ts';

function createSource(options, transformCallback?) {
    const source = new RasterTileSource('id', options, {send() {}} as any as Dispatcher, options.eventedParent);
    source.onAdd({
        transform: {angle: 0, pitch: 0, showCollisionBoxes: false},
        _getMapId: () => 1,
        _requestManager: new RequestManager(transformCallback),
        getPixelRatio() { return 1; },
        style: {projection: new MercatorProjection()}
    } as any);

    source.on('error', () => { }); // to prevent console log of errors

    return source;
}

describe('RasterTileSource', () => {
    let server: FakeServer;
    beforeEach(() => {
        global.fetch = null;
        server = fakeServer.create();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        server.restore();
    });

    test('fallbacks wait for regional sources on every view and then use more than two slots', async () => {
        ImageRequest.resetRequestQueue();
        stubAjaxGetImage(undefined);
        const source = createSource({tiles: ['http://example.com/{z}/{x}/{y}.webp']});
        let regionalLoaded = false;
        let moving = false;
        source.map.isMoving = () => moving;
        source.map.getSource = vi.fn(() => ({}) as any);
        source.map.isSourceLoaded = vi.fn(() => regionalLoaded);
        source.map.painter = {context: {}, getTileTexture: () => ({update() {}})} as any;
        await waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        source.setRequestPriority('fallback', ['regional']);

        const tiles = Array.from({length: 8}, (_, x) => ({
            tileID: new OverscaledTileID(4, 0, 4, x, 4), state: 'loading'
        } as Tile));
        const pending = tiles.slice(0, 6).map(tile => source.loadTile(tile));
        await sleep(0);
        expect(server.requests).toHaveLength(0);
        regionalLoaded = true;
        ImageRequest.processQueue();
        expect(server.requests).toHaveLength(6);

        regionalLoaded = false;
        pending.push(source.loadTile(tiles[6]));
        pending.push(source.loadTile(tiles[7]));
        await sleep(0);
        for (const request of server.requests) request.respond(200);
        await Promise.all(pending.slice(0, 6));
        expect(server.requests).toHaveLength(6);
        tiles[7].aborted = true;
        await source.abortTile(tiles[7]);
        regionalLoaded = true;
        moving = true;
        ImageRequest.processQueue();
        expect(server.requests).toHaveLength(6);
        moving = false;
        ImageRequest.processQueue();
        expect(server.requests).toHaveLength(7);
        server.requests[6].respond(200);
        await Promise.all(pending);
        expect(source.map.isSourceLoaded).toHaveBeenCalledWith('regional');
    });

    test('fallback dependencies follow the selected forecast and wait for the next viewport update', async () => {
        ImageRequest.resetRequestQueue();
        stubAjaxGetImage(undefined);
        const source = createSource({tiles: ['http://example.com/{z}/{x}/{y}.webp']});
        source.map.isMoving = () => false;
        source.map.getSource = vi.fn(() => undefined);
        source.map.isSourceLoaded = vi.fn(() => true);
        source.map.painter = {context: {}, getTileTexture: () => ({update() {}})} as any;
        await waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        source.setRequestPriority('fallback', ['missing']);
        const pending = source.loadTile({tileID: new OverscaledTileID(4, 0, 4, 1, 4), state: 'loading'} as Tile);
        await sleep(0);
        expect(server.requests).toHaveLength(0);

        source.map.getSource = vi.fn(() => ({}) as any);
        source.map._sourcesDirty = true;
        source.setRequestDependencies(['next-region-frame']);
        expect(source.getRequestDependencies()).toEqual(['next-region-frame']);
        expect(server.requests).toHaveLength(0);
        source.map._sourcesDirty = false;
        ImageRequest.processQueue();
        expect(server.requests).toHaveLength(1);
        expect(source.map.isSourceLoaded).toHaveBeenCalledWith('next-region-frame');
        server.requests[0].respond(200);
        await pending;
        expect(() => source.setRequestDependencies([source.id])).toThrow('cannot depend on itself');
    });

    test('transforms request for TileJSON URL', () => {
        server.respondWith('/source.json', JSON.stringify({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, -5]
        }));
        const transformSpy = vi.fn().mockImplementation((url) => {
            return {url};
        });

        createSource({url: '/source.json'}, transformSpy);
        server.respond();

        expect(transformSpy.mock.calls[0][0]).toBe('/source.json');
        expect(transformSpy.mock.calls[0][1]).toBe('Source');
    });

    test('can asynchronously transform request for TileJSON URL', async () => {
        server.respondWith('/source.json', JSON.stringify({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, -5]
        }));
        const source = createSource({url: '/source.json'}, async (url) => ({
            url,
            headers: {Authorization: 'Bearer token'}
        }));
        const promise = waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        await sleep(0);
        server.respond();
        await promise;
        expect(server.requests[0].url).toBe('/source.json');
        expect(server.requests[0].requestHeaders.Authorization).toBe('Bearer token');
    });

    test('fires "error" event if TileJSON request fails', async () => {
        server.respondWith('/source.json', [404, {}, '']);

        const source = createSource({url: '/source.json'});
        const errorEvent = waitForEvent(source, 'error', (e) => e.error.status === 404);
        await sleep(0);
        server.respond();

        await expect(errorEvent).resolves.toBeDefined();
        expect(source.loaded()).toBe(true);
    });

    test('respects TileJSON.bounds', async () => {
        const source = createSource({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, -5]
        });

        await waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');

        expect(source.hasTile(new OverscaledTileID(8, 0, 8, 96, 132))).toBeFalsy();
        expect(source.hasTile(new OverscaledTileID(8, 0, 8, 95, 132))).toBeTruthy();
    });

    test('does not error on invalid bounds', async () => {
        const source = createSource({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, 91]
        });

        await waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');

        expect(source.tileBounds.bounds).toEqual({_sw: {lng: -47, lat: -7}, _ne: {lng: -45, lat: 90}});
    });

    test('respects TileJSON.bounds when loaded from TileJSON', async () => {
        server.respondWith('/source.json', JSON.stringify({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, -5]
        }));
        const source = createSource({url: '/source.json'});

        const promise = waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        await sleep(0);
        server.respond();

        await promise;
        expect(source.hasTile(new OverscaledTileID(8, 0, 8, 96, 132))).toBeFalsy();
        expect(source.hasTile(new OverscaledTileID(8, 0, 8, 95, 132))).toBeTruthy();
    });

    test('transforms tile urls before requesting', async () => {
        server.respondWith('/source.json', JSON.stringify({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, -5]
        }));
        const source = createSource({url: '/source.json'});
        const transformSpy = vi.spyOn(source.map._requestManager, 'transformRequest');
        const promise = waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        await sleep(0);
        server.respond();
        await promise;
        const tile = {
            tileID: new OverscaledTileID(10, 0, 10, 5, 5),
            state: 'loading',
            loadVectorData () {},
            setExpiryData() {}
        } as any as Tile;
        source.loadTile(tile);
        expect(transformSpy).toHaveBeenCalledTimes(1);
        expect(transformSpy.mock.calls[0][0]).toBe('http://example.com/10/5/5.png');
        expect(transformSpy.mock.calls[0][1]).toBe('Tile');
    });

    test('an empty tile response loads as a transparent tile, so the parent does not show through', async () => {
        server.respondWith('/source.json', JSON.stringify({
            minzoom: 0,
            maxzoom: 22,
            tiles: ['http://example.com/{z}/{x}/{y}.png']
        }));
        const source = createSource({url: '/source.json'});
        vi.spyOn(ImageRequest, 'getImage').mockResolvedValue({data: null});
        const update = vi.fn();
        source.map.painter = {context: {}, getTileTexture: () => ({update})} as any;
        const promise = waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        await sleep(0);
        server.respond();
        await promise;
        const tile = {
            tileID: new OverscaledTileID(10, 0, 10, 5, 5),
            state: 'loading',
            loadVectorData () {},
            setExpiryData() {}
        } as any as Tile;
        await source.loadTile(tile);

        expect(tile.state).toBe('loaded');
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({width: 1, height: 1, data: new Uint8Array(4)}),
            expect.anything());
    });

    test('can asynchronously transform tile request', async () => {
        server.respondWith('http://example.com/10/5/5.png',
            [200, {'Content-Type': 'image/png', 'Content-Length': 1, 'Cache-Control': 'max-age=100'}, '0']
        );

        const source = createSource({
            tiles: ['http://example.com/{z}/{x}/{y}.png']
        }, async (url) => ({
            url,
            headers: {Authorization: 'Bearer token'}
        }));
        source.map.painter = {context: {}, getTileTexture: () => ({update: () => {}})} as any;
        await waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');

        const tile = {
            tileID: new OverscaledTileID(10, 0, 10, 5, 5),
            state: 'loading',
            loadVectorData () {},
            setExpiryData() {}
        } as any as Tile;
        const promise = source.loadTile(tile);
        await sleep(0);
        server.respond();
        await promise;
        expect(server.requests[0].url).toBe('http://example.com/10/5/5.png');
        expect(server.requests[0].requestHeaders.Authorization).toBe('Bearer token');
        expect(tile.state).toBe('loaded');
    });

    test('HttpImageElement used to get image when refreshExpiredTiles is false', async () => {
        stubAjaxGetImage(undefined);
        server.respondWith('/source.json', JSON.stringify({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, -5]
        }));
        const source = createSource({url: '/source.json'});
        source.map.painter = {context: {}, getTileTexture: () => ({update: () => {}})} as any;
        source.map._refreshExpiredTiles = false;

        const imageConstructorSpy = vi.spyOn(global, 'Image');
        const promise = waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        await sleep(0);
        server.respond();
        await promise;
        const tile = {
            tileID: new OverscaledTileID(10, 0, 10, 5, 5),
            state: 'loading'
        } as any as Tile;
        await source.loadTile(tile);
        expect(imageConstructorSpy).toHaveBeenCalledTimes(1);
        expect(tile.state).toBe('loaded');
    });

    test('supports updating tiles', async () => {
        server.respondWith('/source.json', JSON.stringify({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
        }));
        const source = createSource({url: '/source.json'});

        server.respondImmediately = true;
        const promise = waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        source.setTiles(['http://example.com/{z}/{x}/{y}.png?updated=true']);
        await promise;

        expect(source.tiles[0]).toBe('http://example.com/{z}/{x}/{y}.png?updated=true');
    });

    test('loadTile requests the new URLs right after setTiles, before the source reloads', () => {
        const source = createSource({tiles: ['http://example.com/{z}/{x}/{y}.png']});
        const transformSpy = vi.spyOn(source.map._requestManager, 'transformRequest');

        source.setTiles(['http://example2.com/{z}/{x}/{y}.png']);

        source.loadTile({
            tileID: new OverscaledTileID(10, 0, 10, 5, 5),
            state: 'loading'
        } as any as Tile);

        expect(transformSpy.mock.calls[0][0]).toBe('http://example2.com/10/5/5.png');
    });

    test('cancels TileJSON request if removed', async () => {
        const source = createSource({url: '/source.json'});
        await sleep(0);
        source.onRemove();
        expect((server.lastRequest as any).aborted).toBe(true);
    });

    test('supports url property updates', async () => {
        server.respondWith('http://localhost:2900/source2.json', JSON.stringify({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, -5]
        }));

        const source = createSource({
            url: 'http://localhost:2900/source.json'
        });
        await sleep(0);
        const errorHandler = vi.fn();
        source.on('error', errorHandler);
        source.setUrl('http://localhost:2900/source2.json');

        await sleep(0);
        server.respond();

        await waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');

        expect(server.requests).toHaveLength(2);
        expect(server.requests[0].aborted).toBe(true);
        expect(source.serialize()).toEqual({
            type: 'raster',
            url: 'http://localhost:2900/source2.json'
        });
        expect(errorHandler).not.toHaveBeenCalled();
    });

    test('serializes options', () => {
        const source = createSource({
            tiles: ['http://localhost:2900/raster/{z}/{x}/{y}.png'],
            minzoom: 2,
            maxzoom: 10
        });

        expect(source.serialize()).toStrictEqual({
            type: 'raster',
            tiles: ['http://localhost:2900/raster/{z}/{x}/{y}.png'],
            minzoom: 2,
            maxzoom: 10
        });
    });

    test('does not serialize runtime premultiplyAlpha setting', () => {
        const source = createSource({
            tiles: ['http://localhost:2900/raster/{z}/{x}/{y}.png']
        });
        source.setPremultiplyAlpha(false);

        expect(source.serialize()).toStrictEqual({
            type: 'raster',
            tiles: ['http://localhost:2900/raster/{z}/{x}/{y}.png']
        });
    });

    test('setPremultiplyAlpha reloads source content when changed', async () => {
        const source = createSource({
            tiles: ['http://example.com/{z}/{x}/{y}.png']
        });
        const initialDataEvent: MapSourceDataEvent = await waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'content');
        expect(initialDataEvent.sourceDataChanged).toBe(false);

        const dataEvent = waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'content' && e.sourceDataChanged === true);

        expect(source.setPremultiplyAlpha(false)).toBe(source);

        await expect(dataEvent).resolves.toBeDefined();
    });

    test.each(['setter', 'source option'])('loadTile preserves raw raster bytes using the %s', async (method) => {
        const source = createSource({
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            premultiply: method !== 'source option'
        });
        if (method === 'setter') source.setPremultiplyAlpha(false);
        source.tiles = ['http://example.com/{z}/{x}/{y}.png'];
        source.map._refreshExpiredTiles = false;

        const image = new ImageBitmap();
        Object.defineProperties(image, {width: {value: 256}, height: {value: 256}});
        const close = vi.spyOn(image, 'close');
        const decode = vi.fn().mockResolvedValue(image);
        stubAjaxGetImage(decode);
        server.respondWith('http://example.com/10/5/5.png', [200, {'Content-Type': 'image/jxl'}, 'image bytes']);
        const update = vi.fn();
        source.map.painter = {
            context: {gl: {}},
            getTileTexture: () => ({update})
        } as any;

        const tile = {
            tileID: new OverscaledTileID(10, 0, 10, 5, 5),
            state: 'loading',
            setExpiryData() {}
        } as any as Tile;

        const loaded = source.loadTile(tile);
        await sleep(0);
        server.respond();
        await loaded;

        expect(decode).toHaveBeenCalledWith(
            expect.objectContaining({type: 'image/jxl'}),
            {premultiplyAlpha: 'none', colorSpaceConversion: 'none'}
        );
        expect(update).toHaveBeenCalledWith(image, {useMipmap: true, premultiply: false});
        expect(tile.state).toBe('loaded');
        expect(close).toHaveBeenCalledTimes(1);
    });

    test.each([true, false])('uploads raster tiles with mipmaps enabled: %s', async (useMipmaps) => {
        const options = {tiles: ['http://example.com/{z}/{x}/{y}.png']};
        const source = createSource(options);
        await waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'content');
        if (!useMipmaps) {
            const reloaded = waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataChanged === true);
            expect(source.setMipmaps(false)).toBe(source);
            await reloaded;
        }
        expect(source.serialize()).toEqual({type: 'raster', ...options});
        const image = new ImageBitmap();
        Object.defineProperties(image, {width: {value: 256}, height: {value: 256}});
        stubAjaxGetImage(vi.fn().mockResolvedValue(image));
        server.respondWith('http://example.com/4/1/4.png', [200, {'Content-Type': 'image/png'}, 'image bytes']);
        const gl = createNullGL();
        source.map.painter = {context: new Context(gl), getTileTexture: () => null} as any;
        const tile = {tileID: new OverscaledTileID(4, 0, 4, 1, 4), state: 'loading'} as Tile;
        const loaded = source.loadTile(tile);
        await sleep(0);
        server.respond();
        await loaded;
        expect(tile.state).toBe('loaded');
        expect(tile.texture.useMipmap).toBe(useMipmaps);
        expect(gl.texStorage2D).toHaveBeenCalledWith(gl.TEXTURE_2D, useMipmaps ? 9 : 1, gl.RGBA8, 256, 256);
        expect(gl.generateMipmap).toHaveBeenCalledTimes(useMipmaps ? 1 : 0);
        expect(gl.texParameteri).toHaveBeenCalledWith(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, useMipmaps ? gl.LINEAR_MIPMAP_NEAREST : gl.LINEAR);
    });

    test.each(['cancelled', 'upload failed'])('releases a decoded bitmap when tile loading is %s', async (outcome) => {
        const source = createSource({tiles: ['http://example.com/{z}/{x}/{y}.png']});
        await waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        const tile = {tileID: new OverscaledTileID(4, 0, 4, 1, 4), state: 'loading'} as Tile;
        const image = new ImageBitmap();
        const close = vi.spyOn(image, 'close');
        stubAjaxGetImage(vi.fn().mockImplementation(async () => {
            if (outcome === 'cancelled') tile.aborted = true;
            return image;
        }));
        server.respondWith('http://example.com/4/1/4.png', [200, {'Content-Type': 'image/png'}, 'image bytes']);
        const update = vi.fn(() => {
            expect(close).not.toHaveBeenCalled();
            throw new Error('upload failed');
        });
        source.map.painter = {context: {}, getTileTexture: () => ({update})} as any;
        const loaded = source.loadTile(tile);
        const settled = outcome === 'upload failed'
            ? expect(loaded).rejects.toThrow('upload failed')
            : expect(loaded).resolves.toBeUndefined();
        await sleep(0);
        server.respond();
        await settled;
        expect(close).toHaveBeenCalledTimes(1);
        expect(tile.state).toBe(outcome === 'cancelled' ? 'unloaded' : 'errored');
        expect(update).toHaveBeenCalledTimes(outcome === 'cancelled' ? 0 : 1);
    });

    test('Tile expiry data is set when "Cache-Control" is set but not "Expires"', async () => {
        server.respondWith('/source.json', JSON.stringify({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, -5]
        }));
        server.respondWith('http://example.com/10/5/5.png',
            [200, {'Content-Type': 'image/png', 'Content-Length': 1, 'Cache-Control': 'max-age=100'}, '0']
        );
        const source = createSource({url: '/source.json'});
        source.map.painter = {context: {}, getTileTexture: () => ({update: () => {}})} as any;
        source.map._refreshExpiredTiles = true;

        const promise = waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        await sleep(0);
        server.respond();
        await promise;
        const tile = {
            tileID: new OverscaledTileID(10, 0, 10, 5, 5),
            state: 'loading',
            setExpiryData() {}
        } as any as Tile;
        const expiryDataSpy = vi.spyOn(tile, 'setExpiryData');
        const tilePromise = source.loadTile(tile);
        await sleep(0);
        server.respond();
        await tilePromise;
        expect(tile.state).toBe('loaded');
        expect(expiryDataSpy).toHaveBeenCalledTimes(1);
    });

    test('Tile expiry data is set when "Expires" is set but not "Cache-Control"', async () => {
        server.respondWith('/source.json', JSON.stringify({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, -5]
        }));
        server.respondWith('http://example.com/10/5/5.png',
            [200, {'Content-Type': 'image/png', 'Content-Length': 1, 'Expires': 'Wed, 21 Oct 2015 07:28:00 GMT'}, '0']
        );
        const source = createSource({url: '/source.json'});
        source.map.painter = {context: {}, getTileTexture: () => ({update: () => {}})} as any;
        source.map._refreshExpiredTiles = true;

        const promise = waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        await sleep(0);
        server.respond();
        await promise;
        const tile = {
            tileID: new OverscaledTileID(10, 0, 10, 5, 5),
            state: 'loading',
            setExpiryData() {}
        } as any as Tile;
        const expiryDataSpy = vi.spyOn(tile, 'setExpiryData');
        const tilePromise = source.loadTile(tile);
        await sleep(0);
        server.respond();
        await tilePromise;
        expect(tile.state).toBe('loaded');
        expect(expiryDataSpy).toHaveBeenCalledTimes(1);
    });

    test('Tile expiry data is set when "Expires" is set and "Cache-Control" is an empty string', async () => {
        server.respondWith('/source.json', JSON.stringify({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, -5]
        }));
        server.respondWith('http://example.com/10/5/5.png',
            [200, {'Content-Type': 'image/png', 'Content-Length': 1, 'Cache-Control': '', 'Expires': 'Wed, 21 Oct 2015 07:28:00 GMT'}, '0']
        );
        const source = createSource({url: '/source.json'});
        source.map.painter = {context: {}, getTileTexture: () => ({update: () => {}})} as any;
        source.map._refreshExpiredTiles = true;

        const promise = waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');
        await sleep(0);
        server.respond();
        await promise;
        const tile = {
            tileID: new OverscaledTileID(10, 0, 10, 5, 5),
            state: 'loading',
            setExpiryData() {}
        } as any as Tile;
        const expiryDataSpy = vi.spyOn(tile, 'setExpiryData');
        const tilePromise = source.loadTile(tile);
        await sleep(0);
        server.respond();
        await tilePromise;
        expect(tile.state).toBe('loaded');
        expect(expiryDataSpy).toHaveBeenCalledTimes(1);
    });

    test('does not request a tile that was aborted while its request was being transformed', async () => {
        let releaseTransform: (params: {url: string}) => void;
        const source = createSource({
            tiles: ['http://example.com/{z}/{x}/{y}.png']
        }, (url, type) => {
            if (type !== 'Tile') return {url};
            return new Promise<{url: string}>((resolve) => {
                releaseTransform = resolve;
            });
        });
        source.tiles = ['http://example.com/{z}/{x}/{y}.png'];

        const tile = {
            tileID: new OverscaledTileID(10, 0, 10, 5, 5),
            state: 'loading',
            setExpiryData() {}
        } as any as Tile;

        const loadPromise = source.loadTile(tile);
        tile.aborted = true;
        await source.abortTile(tile);
        releaseTransform({url: 'http://example.com/10/5/5.png'});
        await expect(loadPromise).resolves.toBeUndefined();

        expect(server.requests).toHaveLength(0);
        expect(tile.state).toBe('unloaded');
    });

    test('does not throw when tile is aborted', async () => {
        const source = createSource({
            minzoom: 0,
            maxzoom: 22,
            attribution: 'MapLibre',
            tiles: ['http://example.com/{z}/{x}/{y}.png'],
            bounds: [-47, -7, -45, -5]
        });

        await waitForEvent(source, 'data', (e: MapSourceDataEvent) => e.sourceDataType === 'metadata');

        const tile = {
            tileID: new OverscaledTileID(5, 0, 5, 31, 5),
            state: 'loading',
            loadVectorData() {},
            setExpiryData() {}
        } as any as Tile;
        const loadPromise = source.loadTile(tile);
        await sleep(0);

        tile.abortController.abort();
        tile.aborted = true;

        await expect(loadPromise).resolves.toBeUndefined();
        expect(tile.state).toBe('unloaded');
    });
});
