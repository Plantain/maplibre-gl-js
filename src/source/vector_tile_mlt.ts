import {decodeTile, GEOMETRY_TYPE} from '@maplibre/mlt';
import {arrayBufferSize} from '../util/array_buffer_size.ts';
import {MLTGeometry} from './vector_tile_mlt_geometry.ts';

import type Point from '@mapbox/point-geometry';
import type {FeatureTable} from '@maplibre/mlt';
import type {VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike} from '@maplibre/vt-pbf';

class MLTVectorTileFeature implements VectorTileFeatureLike {
    private readonly layer: MLTVectorTileLayer;
    private readonly index: number;
    private materializedProperties: Record<string, any>;
    type: VectorTileFeatureLike['type'];
    extent: VectorTileFeatureLike['extent'];
    id: VectorTileFeatureLike['id'];

    constructor(layer: MLTVectorTileLayer, index: number) {
        this.layer = layer;
        this.index = index;
        switch (layer.geometry.geometryType(index)) {
            case GEOMETRY_TYPE.POINT:
            case GEOMETRY_TYPE.MULTIPOINT:
                this.type = 1;
                break;
            case GEOMETRY_TYPE.LINESTRING:
            case GEOMETRY_TYPE.MULTILINESTRING:
                this.type = 2;
                break;
            case GEOMETRY_TYPE.POLYGON:
            case GEOMETRY_TYPE.MULTIPOLYGON:
                this.type = 3;
                break;
            default:
                this.type = 0;
        }
        this.extent = layer.extent;
        this.id = Number(layer.idVector?.getValue(index) ?? undefined);
    }

    /** Materializes properties for this feature wrapper without expanding the layer's other features. */
    get properties(): Record<string, any> {
        if (this.materializedProperties) return this.materializedProperties;
        const properties: Record<string, any> = {};
        for (const column of this.layer.propertyVectors) {
            if (!column) continue;
            const value = column.getValue(this.index);
            if (value !== null) properties[column.name] = value;
        }
        return this.materializedProperties = properties;
    }

    loadGeometry(): Point[][] {
        return this.layer.geometry.loadGeometry(this.index);
    }
}

class MLTVectorTileLayer implements VectorTileLayerLike {
    idVector: FeatureTable['idVector'];
    propertyVectors: FeatureTable['propertyVectors'];
    name: string;
    length: number;
    version: number;
    extent: number;
    geometry: MLTGeometry;

    constructor(featureTable: FeatureTable) {
        this.idVector = featureTable.idVector;
        this.propertyVectors = featureTable.propertyVectors;
        this.name = featureTable.name;
        this.extent = featureTable.extent;
        this.version = 2;
        this.length = featureTable.numFeatures;
        this.geometry = new MLTGeometry(featureTable.geometryVector);
    }

    feature(i: number): VectorTileFeatureLike {
        if (!Number.isInteger(i) || i < 0 || i >= this.length) throw new RangeError('MLT feature index out of bounds');
        return new MLTVectorTileFeature(this, i);
    }
}

export class MLTVectorTile implements VectorTileLike {
    layers: Record<string, VectorTileLayerLike> = {};
    /** Unique decoded backing stores, excluding the response body and JS object overhead. */
    readonly byteLength: number;

    constructor(buffer: ArrayBuffer) {
        const features = decodeTile(new Uint8Array(buffer));
        for (const table of features) this.layers[table.name] = new MLTVectorTileLayer(table);
        this.byteLength = arrayBufferSize(this.layers, buffer);
    }
}
