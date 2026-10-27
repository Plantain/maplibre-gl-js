import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, test, vi} from 'vitest';
import {decodeTile, encodeTile, FeatureTable, GeometryVector, GpuVector} from '@maplibre/mlt';
import {FlatGeometryVector} from '@maplibre/mlt/dist/vector/geometry/flatGeometryVector';
import {VertexBufferType} from '@maplibre/mlt/dist/vector/geometry/vertexBufferType';
import {encodeZOrderCurve} from '@maplibre/mlt/dist/encoding/zOrderCurveEncoder';
import Point from '@mapbox/point-geometry';
import {MLTVectorTile} from './vector_tile_mlt.ts';
import {MLTGeometry, compactCoordinates, compactOffsets} from './vector_tile_mlt_geometry.ts';
import {loadGeometry} from '../data/load_geometry.ts';
import {sliceVectorTileLayer} from './vector_tile_overzoomed.ts';
import {CanonicalTileID} from '../tile/tile_id.ts';
import {arrayBufferSize} from '../util/array_buffer_size.ts';

import type {FeatureInput, FeatureGeometry} from '@maplibre/mlt';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

const geometries: FeatureGeometry[] = [
    {type: 'Point', coordinates: [15, 25]},
    {type: 'MultiPoint', coordinates: [[45, 55], [65, 75]]},
    {type: 'LineString', coordinates: [[10, 20], [30, 50], [60, 70]]},
    {type: 'MultiLineString', coordinates: [[[5, 10], [20, 40]], [[30, 35], [45, 50], [65, 70]]]},
    {type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100]], [[20, 20], [20, 30], [30, 20]]]},
    {type: 'MultiPolygon', coordinates: [
        [[[10, 10], [90, 10], [90, 90], [10, 90]], [[30, 30], [30, 50], [50, 30]]],
        [[[110, 110], [180, 110], [180, 180], [110, 180]]]
    ]}
];

/** Copies decoded coordinates to match MapLibre's independent, mutable ring-closing points. */
function referenceLayer(buffer: ArrayBuffer, name: string): VectorTileLayerLike {
    const table = decodeTile(new Uint8Array(buffer)).find(layer => layer.name === name);
    const features = table.getFeatures();
    return {
        name, extent: table.extent, version: 2, length: features.length,
        feature(index) {
            const data = features[index];
            return {
                id: Number(data.id), properties: data.properties as Record<string, any>, extent: table.extent,
                type: (data.geometry.type % 3 + 1) as 1 | 2 | 3,
                loadGeometry: () => data.geometry.coordinates.map(ring => ring.map(p => new Point(p.x, p.y)))
            };
        }
    };
}

/** Exercises out-of-order queries and repeated mutable geometry reads through the public tile API. */
function compareLayer(actual: VectorTileLayerLike, expected: VectorTileLayerLike): void {
    expect([actual.length, actual.extent, actual.version]).toEqual([expected.length, expected.extent, expected.version]);
    for (let i = actual.length - 1; i >= 0; i--) {
        const feature = actual.feature(i);
        const reference = expected.feature(i);
        expect([feature.id, feature.type, feature.extent, feature.properties]).toEqual([
            reference.id, reference.type, reference.extent, reference.properties
        ]);
        const coordinates = reference.loadGeometry();
        expect(feature.loadGeometry()).toEqual(coordinates);
        expect(loadGeometry(feature)).toEqual(loadGeometry(reference));
        const mutable = feature.loadGeometry();
        if (mutable[0]?.[0]) mutable[0][0].x = -99999;
        expect(feature.loadGeometry()).toEqual(coordinates);
        expect(actual.feature(i).loadGeometry()).toEqual(coordinates);
    }
}

describe('packed MLT vector tile adapter', () => {
    test('uses exact 16-bit boundaries and preserves wider buffered coordinates and offsets', () => {
        expect(compactCoordinates(new Int32Array([-32768, 32767]))).toEqual(new Int16Array([-32768, 32767]));
        const wideCoordinates = new Int32Array([-32769, 32768]);
        expect(compactCoordinates(wideCoordinates)).toBe(wideCoordinates);
        expect(compactOffsets(new Uint32Array([0, 65535]))).toEqual(new Uint16Array([0, 65535]));
        const wideOffsets = new Uint32Array([0, 65536]);
        expect(compactOffsets(wideOffsets)).toBe(wideOffsets);
        const vertices = new Int32Array(65537 * 2);
        vertices.set([-32769, 32768], 65536 * 2);
        const vector = new FlatGeometryVector(VertexBufferType.VEC_2, new Uint32Array([0]), {},
            new Uint32Array([65536]), vertices);
        expect(new MLTGeometry(vector).loadGeometry(0)).toEqual([[new Point(-32769, 32768)]]);
    });
    test.each(geometries)('reads homogeneous $type layers without expanding unrelated features', geometry => {
        const encoded = encodeTile([{name: 'forecast', extent: 16384, features: [
            {id: 0, geometry, properties: {idx: 0, label: 'first', enabled: false, optional: null}},
            {id: 12345678901234567n, geometry, properties: {idx: 5, label: 'second', enabled: true, optional: 'present'}}
        ]}]);
        const buffer = Uint8Array.from(encoded).buffer;
        const reference = referenceLayer(buffer, 'forecast');
        const allFeatures = vi.spyOn(FeatureTable.prototype, 'getFeatures');
        const allGeometry = vi.spyOn(GeometryVector.prototype, 'getGeometries');
        try {
            const layer = new MLTVectorTile(buffer).layers.forecast;
            compareLayer(layer, reference);
            expect(allFeatures).not.toHaveBeenCalled();
            expect(allGeometry).not.toHaveBeenCalled();
        } finally {
            allFeatures.mockRestore();
            allGeometry.mockRestore();
        }
    });

    test.each([
        {name: 'all geometry types', mixed: [...geometries, ...geometries]},
        {name: 'all types in reverse order', mixed: [...geometries, ...geometries].reverse()},
        {name: 'points and lines without polygon topology', mixed: [...geometries.slice(0, 4), ...geometries.slice(0, 4)]}
    ])('reads mixed layers: $name', ({mixed}) => {
        const features: FeatureInput[] = mixed.map((geometry, id) => ({
            id, geometry, properties: {idx: id, nested: {valid: true, list: [id, 'value']}}
        }));
        const buffer = Uint8Array.from(encodeTile([{name: 'mixed', features}])).buffer;
        const layer = new MLTVectorTile(buffer).layers.mixed;
        expect(layer).toHaveLength(features.length);
        compareLayer(layer, referenceLayer(buffer, 'mixed'));
    });

    test.each([
        'mlt/5/17/10.mlt',
        'mlt/5/22/12.mlt',
        'mlt/14/8716/5685.mlt',
        'mlt/14/8717/5679.mlt',
        'mlt-untessellated/5/22/12.mlt',
        'mlt-untessellated/14/8716/5685.mlt'
    ])('matches pre-tessellated and plain fixture %s', file => {
        const buffer = Uint8Array.from(readFileSync(path.join(__dirname, '../../test/integration/assets/tiles', file))).buffer;
        const references = Object.fromEntries(decodeTile(new Uint8Array(buffer)).map(table => [table.name, referenceLayer(buffer, table.name)]));
        const allFeatures = vi.spyOn(FeatureTable.prototype, 'getFeatures');
        const allGeometry = vi.spyOn(GpuVector.prototype, 'getGeometries');
        try {
            const actual = new MLTVectorTile(buffer);
            for (const [name, layer] of Object.entries(actual.layers)) compareLayer(layer, references[name]);
            expect(actual.byteLength).toBe(arrayBufferSize(actual.layers, buffer));
            expect(allFeatures).not.toHaveBeenCalled();
            expect(allGeometry).not.toHaveBeenCalled();
        } finally {
            allFeatures.mockRestore();
            allGeometry.mockRestore();
        }
    });

    test.each([false, true])('reads reordered vertex dictionaries (Morton: %s)', morton => {
        const encoded = encodeTile([{name: 'mixed', features: geometries.map(geometry => ({geometry}))}]);
        const source = decodeTile(encoded)[0].geometryVector as GeometryVector;
        const count = source.vertexBuffer.length / 2;
        const offsets = new Uint32Array(count);
        const dictionary = new Int32Array(count * (morton ? 1 : 2));
        const settings = {numBits: 16, coordinateShift: 512};
        for (let i = 0; i < count; i++) {
            const [x, y] = source.getVertex(i);
            const offset = count - i - 1;
            offsets[i] = offset;
            if (morton) dictionary[offset] = encodeZOrderCurve(x, y, settings.numBits, settings.coordinateShift);
            else dictionary.set([x, y], offset * 2);
        }
        const types = Uint32Array.from(geometries.map((_, i) => source.geometryType(i)));
        const vector = new FlatGeometryVector(morton ? VertexBufferType.MORTON : VertexBufferType.VEC_2,
            types, source.topologyVector, offsets, dictionary, morton ? settings : undefined);
        const geometry = new MLTGeometry(vector);
        const expected = source.getGeometries();
        for (let i = types.length - 1; i >= 0; i--) {
            const points = geometry.loadGeometry(i);
            expect(points).toEqual(expected[i]);
            points[0][0].x = -99999;
            expect(geometry.loadGeometry(i)).toEqual(expected[i]);
        }
    });

    test('overzooming and repeated reads preserve the parent geometry and hole boundaries', () => {
        const buffer = Uint8Array.from(encodeTile([{name: 'forecast', extent: 256, features: [
            {geometry: geometries[4], properties: {idx: 5}},
            {geometry: geometries[5], properties: {idx: 6}}
        ]}])).buffer;
        const layer = new MLTVectorTile(buffer).layers.forecast;
        const expected = referenceLayer(buffer, 'forecast');
        const parent = new CanonicalTileID(0, 0, 0);
        for (const child of [new CanonicalTileID(1, 0, 0), new CanonicalTileID(1, 1, 1)]) {
            const childLayer = sliceVectorTileLayer(layer, parent, child);
            expect(childLayer.length).toBeGreaterThan(0);
            compareLayer(childLayer, sliceVectorTileLayer(expected, parent, child));
            compareLayer(layer, expected);
        }
    });

    test('handles empty tiles and rejects out-of-range feature queries', () => {
        expect(new MLTVectorTile(new ArrayBuffer(0)).layers).toEqual({});
        const buffer = Uint8Array.from(encodeTile([{name: 'point', features: [{geometry: geometries[0]}]}])).buffer;
        const layer = new MLTVectorTile(buffer).layers.point;
        expect(layer.feature(0).id).toBeNaN();
        for (const index of [-1, 1, 0.5]) expect(() => layer.feature(index)).toThrow(RangeError);
    });

    test('measures tiles with large nested property arrays without hitting argument limits', () => {
        const samples = Array.from({length: 150000}, (_, i) => i);
        const buffer = Uint8Array.from(encodeTile([{name: 'forecast', features: [{
            geometry: {type: 'Point', coordinates: [10, 20]}, properties: {samples}
        }]}])).buffer;
        const tile = new MLTVectorTile(buffer);
        expect(tile.layers.forecast.feature(0).properties.samples).toEqual(samples);
        expect(tile.layers.forecast.feature(0).loadGeometry()).toEqual([[new Point(10, 20)]]);
        expect(tile.byteLength).toBeGreaterThan(0);
    });
});
