import {afterEach, expect, test} from 'vitest';
import {encodeTile} from '@maplibre/mlt';
import {DecodedTileCache, decodedMLTCache} from './decoded_tile_cache.ts';
import {FeatureIndex} from './feature_index.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {Tile} from '../tile/tile.ts';
import {mercatorWorldCoordinateHelper} from '../geo/mercator_coordinate.ts';
import {FillStyleLayer} from '../style/style_layer/fill_style_layer.ts';
import {EvaluationParameters} from '../style/evaluation_parameters.ts';
import {loadGeometry} from './load_geometry.ts';
import {createMercatorTransform} from '../geo/projection/mercator_transform.ts';
import Point from '@mapbox/point-geometry';

import type {VectorTileLayerLike} from '@maplibre/vt-pbf';
import type {WorkerTileResult} from '../source/worker_source.ts';
import type {MapGeoJSONFeature} from '../util/vectortile_to_geojson.ts';

function owner(): {vtLayers?: Record<string, VectorTileLayerLike>} { return {vtLayers: {}}; }

afterEach(() => {
    decodedMLTCache.clear();
    decodedMLTCache.setMaxBytes(4 * 1024 * 1024);
});

test('evicts least recently used decoded data, bounds empty entries and responds to budget changes', () => {
    const cache = new DecodedTileCache(10, 2);
    const a = owner(), b = owner(), c = owner();
    cache.add(a, 5);
    cache.add(b, 5);
    cache.touch(a);
    cache.add(c, 5);
    expect(a.vtLayers).toBeDefined();
    expect(b.vtLayers).toBeUndefined();
    expect(cache.byteLength).toBe(10);
    cache.setMaxBytes(5);
    expect(a.vtLayers).toBeUndefined();
    expect(c.vtLayers).toBeDefined();
    cache.add(owner(), 0);
    cache.add(owner(), 0);
    expect(c.vtLayers).toBeUndefined();
    cache.clear();
    expect(cache.byteLength).toBe(0);
});

test('pins oversized entries through nested queries and releases them after a throw', () => {
    const cache = new DecodedTileCache(1);
    const a = owner(), b = owner();
    expect(() => cache.withPinned(a, () => {
        cache.add(a, 10);
        cache.withPinned(b, () => {
            cache.add(b, 20);
            expect(a.vtLayers).toBeDefined();
            expect(b.vtLayers).toBeDefined();
        });
        expect(a.vtLayers).toBeDefined();
        expect(b.vtLayers).toBeUndefined();
        throw new Error('query failed');
    })).toThrow('query failed');
    expect(a.vtLayers).toBeUndefined();
    expect(cache.byteLength).toBe(0);
});

function pointTile(value: number): ArrayBuffer {
    return Uint8Array.from(encodeTile([{name: 'forecast', features: [
        {id: 42, geometry: {type: 'Point', coordinates: [100, 200]}, properties: {value}}
    ]}])).buffer;
}

test('queries reconstruct evicted layers, preserve held results and invalidate changed response bytes', () => {
    decodedMLTCache.setMaxBytes(0);
    const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
    const index = new FeatureIndex(tileID);
    const tile = new Tile(tileID, 512);
    tile.loadVectorData({featureIndex: index, rawTileData: pointTile(7), encoding: 'mlt', buckets: []} as WorkerTileResult, null);
    const first = [];
    tile.querySourceFeatures(first, {sourceLayer: 'forecast', worldCoordinateHelper: mercatorWorldCoordinateHelper});
    const expected = first[0].toJSON();
    expect(expected.properties.value).toBe(7);
    expect(index.vtLayers).toBeUndefined();
    const repeated = [];
    tile.querySourceFeatures(repeated, {sourceLayer: 'forecast', worldCoordinateHelper: mercatorWorldCoordinateHelper});
    expect(repeated[0].toJSON()).toEqual(expected);
    decodedMLTCache.setMaxBytes(1024 * 1024);
    index.loadVTLayers();
    index.rawTileData = pointTile(9);
    expect(index.loadVTLayers().forecast.feature(0).properties.value).toBe(9);
    expect(first[0].toJSON()).toEqual(expected);
    tile.unloadVectorData();
    expect(decodedMLTCache.byteLength).toBe(0);
});

test('rendered feature queries keep their layers through nested cache pressure and release them afterward', () => {
    decodedMLTCache.setMaxBytes(0);
    const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
    const index = new FeatureIndex(tileID);
    index.rawTileData = Uint8Array.from(encodeTile([{name: 'forecast', features: [{
        geometry: {type: 'Polygon', coordinates: [[[0, 0], [1024, 0], [1024, 1024], [0, 1024]]]},
        properties: {value: 0.5}
    }]}])).buffer;
    index.encoding = 'mlt';
    index.bucketLayerIDs = [['fill']];
    const feature = index.loadVTLayers().forecast.feature(0);
    index.insert(feature, loadGeometry(feature), 0, 0, 0);
    const other = new FeatureIndex(tileID);
    other.rawTileData = pointTile(1);
    other.encoding = 'mlt';
    let armed = false;
    let survived = false;
    const globalState = {get factor() {
        other.loadVTLayers();
        if (armed) survived = Boolean(index.vtLayers);
        return 1;
    }};
    const specification = {id: 'fill', type: 'fill' as const, source: 'forecast', 'source-layer': 'forecast',
        paint: {'fill-opacity': ['*', ['number', ['get', 'value']], ['number', ['global-state', 'factor']]] as any}};
    const layer = new FillStyleLayer(specification, globalState);
    layer.recalculate(new EvaluationParameters(0), []);
    const transform = createMercatorTransform();
    transform.resize(512, 512);
    armed = true;
    const result = index.query({tileSize: 512, scale: 1, queryPadding: 0, transform,
        queryGeometry: [new Point(100, 100)], cameraQueryGeometry: [new Point(100, 100)],
        params: {}, pixelPosMatrix: undefined, getElevation: undefined}, {fill: layer}, {fill: specification}, undefined);
    expect(survived).toBe(true);
    expect(result.fill[0].feature.toJSON().properties.value).toBe(0.5);
    expect((result.fill[0].feature as MapGeoJSONFeature).layer.paint['fill-opacity']).toBe(0.5);
    expect(index.vtLayers).toBeUndefined();
    expect(decodedMLTCache.byteLength).toBe(0);
});
