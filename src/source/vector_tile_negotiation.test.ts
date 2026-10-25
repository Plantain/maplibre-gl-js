import {afterEach, beforeEach, expect, test} from 'vitest';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fakeServer, type FakeServer} from 'nise';
import {fromVectorTileJs, GeoJSONWrapper, type Feature, type VectorTileLayerLike} from '@maplibre/vt-pbf';
import {VectorTileWorkerSource} from './vector_tile_worker_source.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import {CanonicalTileID, OverscaledTileID} from '../tile/tile_id.ts';
import {Tile} from '../tile/tile.ts';
import {MercatorProjection} from '../geo/projection/mercator_projection.ts';

import type {IActor} from '../util/actor.ts';
import type {WorkerTileParameters, WorkerTileWithData} from './worker_source.ts';

const fixtures = {
    mlt: Uint8Array.from(readFileSync(path.join(__dirname, '../../test/integration/assets/tiles/mlt/5/22/12.mlt'))).buffer,
    mvt: Uint8Array.from(readFileSync(path.join(__dirname, '../../test/integration/assets/tiles/ocean.mvt'))).buffer
};
let server: FakeServer;

beforeEach(() => {
    global.fetch = null;
    server = fakeServer.create();
});

afterEach(() => server.restore());

function createSource(): VectorTileWorkerSource {
    return new VectorTileWorkerSource({sendAsync: async () => ({})} as IActor, new StyleLayerIndex([]), []);
}

function tileParams(): WorkerTileParameters {
    return {
        type: 'vector', source: 'source', uid: 1,
        tileID: new OverscaledTileID(5, 0, 5, 22, 12),
        request: {url: 'http://localhost/tile'},
        encoding: 'mlt', zoom: 5, tileSize: 512, pixelRatio: 1,
        promoteId: undefined, showCollisionBoxes: false,
        subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision
    };
}

function pointLayer(name: string, features: Feature[]): VectorTileLayerLike {
    const layer = new GeoJSONWrapper(features, {version: 2, extent: 4096});
    layer.name = name;
    return layer;
}

test.each([
    {encoding: 'mvt' as const, contentType: 'Application/Vnd.Mapbox-Vector-Tile; charset=binary'},
    {encoding: 'mvt' as const, contentType: 'binary/octet-stream'},
    {encoding: 'mvt' as const, contentType: undefined},
    {encoding: 'mlt' as const, contentType: 'application/vnd.maplibre-tile'},
    {encoding: 'mlt' as const, contentType: 'application/octet-stream'},
    {encoding: 'mlt' as const, contentType: undefined},
])('decodes $encoding ($contentType) and preserves queries across reload and expiry', async ({encoding, contentType}) => {
    server.respondWith(request => request.respond(200, {
        ...(contentType ? {'Content-Type': contentType} : {}), ETag: '"v1"'
    }, fixtures[encoding] as any));
    const source = createSource();
    const params = tileParams();
    const pending = source.loadTile(params);
    server.respond();
    const result = await pending as WorkerTileWithData;
    expect(result.encoding).toBe(encoding);
    expect(result.rawTileData).toEqual(fixtures[encoding]);
    expect(params.encoding).toBe('mlt');

    const tile = new Tile(params.tileID, 512);
    tile.loadVectorData(result, null);
    const sourceLayer = encoding === 'mlt' ? 'landcover' : 'water';
    const worldCoordinateHelper = new MercatorProjection().worldCoordinateHelper;
    const features = [];
    tile.querySourceFeatures(features, {sourceLayer, worldCoordinateHelper});
    expect(features.length).toBeGreaterThan(0);
    tile.loadVectorData(await source.reloadTile(params), null);
    const reloadedFeatures = [];
    tile.querySourceFeatures(reloadedFeatures, {sourceLayer, worldCoordinateHelper});
    expect(reloadedFeatures).toEqual(features);

    const refresh = source.loadTile({...params, etag: '"v1"'});
    server.respond();
    expect((await refresh).etagUnmodified).toBe(true);
});

test('overzoomed MVT fallback is reported and queried as MVT', async () => {
    const source = new VectorTileWorkerSource({sendAsync: async () => ({})} as IActor, new StyleLayerIndex([
        {id: 'water', type: 'fill', source: 'source', 'source-layer': 'water'}
    ]), []);
    server.respondWith(request => request.respond(200, {'Content-Type': 'binary/octet-stream'}, fixtures.mvt as any));
    const params = {
        ...tileParams(), zoom: 6, tileID: new OverscaledTileID(6, 0, 6, 44, 24),
        overzoomParameters: {maxZoomTileID: new CanonicalTileID(5, 22, 12), overzoomRequest: {url: 'http://localhost/parent'}}
    };
    const pending = source.loadTile(params);
    server.respond();
    const result = await pending as WorkerTileWithData;
    expect(server.requests[0].url).toBe('http://localhost/parent');
    expect(result.encoding).toBe('mvt');
    result.featureIndex.encoding = result.encoding;
    result.featureIndex.rawTileData = result.rawTileData;
    expect(result.featureIndex.loadVTLayers().water.length).toBeGreaterThan(0);
});

test('retries MVT when generic response bytes resemble MLT framing', async () => {
    const rawData = Uint8Array.from(fromVectorTileJs({layers: {
        aaaa: pointLayer('aaaa', [
            {type: 1, geometry: [[5839, 5602]], tags: {idx: 53, name: 'a'.repeat(16)}, id: 7859},
            {type: 1, geometry: [[9782, 10269]], tags: {idx: 56, name: 'a'.repeat(49)}, id: 5386}
        ]),
        aaaaa: pointLayer('aaaaa', [
            {type: 1, geometry: [[5499, 3230]], tags: {idx: 97, name: 'a'.repeat(8)}, id: 6815}
        ])
    }})).buffer;
    server.respondWith(request => request.respond(200, {'Content-Type': 'binary/octet-stream'}, rawData as any));
    const source = createSource();
    const params = tileParams();
    const pending = source.loadTile(params);
    server.respond();
    const result = await pending as WorkerTileWithData;
    expect(result.encoding).toBe('mvt');
    expect(result.rawTileData).toEqual(rawData);
    expect(server.requests).toHaveLength(1);

    const tile = new Tile(params.tileID, 512);
    const worldCoordinateHelper = new MercatorProjection().worldCoordinateHelper;
    for (const data of [result, await source.reloadTile(params)]) {
        tile.loadVectorData(data, null);
        const features = [];
        tile.querySourceFeatures(features, {sourceLayer: 'aaaa', worldCoordinateHelper});
        expect(features.map(feature => feature.properties.idx)).toEqual([53, 56]);
        const otherFeatures = [];
        tile.querySourceFeatures(otherFeatures, {sourceLayer: 'aaaaa', worldCoordinateHelper});
        expect(otherFeatures.map(feature => feature.properties.idx)).toEqual([97]);
    }
});

test('honors explicit MIME types and rejects corrupt or still-compressed tiles', () => {
    const source = createSource();
    expect(source.loadVectorTile({...tileParams(), encoding: 'mvt'}, fixtures.mlt, 'application/vnd.maplibre-tile').encoding).toBe('mlt');
    expect(() => source.loadVectorTile(tileParams(), fixtures.mvt, 'application/vnd.maplibre-tile')).toThrow('Unable to parse');
    expect(() => source.loadVectorTile(tileParams(), new TextEncoder().encode('<html>error</html>').buffer, 'binary/octet-stream')).toThrow('Unable to parse');
    expect(() => source.loadVectorTile(tileParams(), new Uint8Array([0x1f, 0x8b, 0]).buffer)).toThrow('data is not gzipped');
    expect(source.loadVectorTile(tileParams(), new ArrayBuffer(0)).vectorTile.layers).toEqual({});
});
