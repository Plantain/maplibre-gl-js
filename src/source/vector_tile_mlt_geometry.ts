import Point from '@mapbox/point-geometry';
import {GEOMETRY_TYPE, GeometryVector} from '@maplibre/mlt';
import {decodeZOrderCurve} from '@maplibre/mlt/dist/vector/geometry/zOrderCurve';

import type {GpuVector} from '@maplibre/mlt';

/**
 * Random access to MLT geometry without retaining expanded coordinate objects.
 * Each feature stores the starting part, ring and vertex offsets in three uint32s.
 * Topology includes placeholder parts/rings for simpler types in mixed layers.
 * Pre-tessellated vectors use their outline topology, as in the decoder's coordinate API.
 */
export class MLTGeometry {
    private readonly types: Uint8Array;
    private readonly vertices: Int16Array | Int32Array | Uint32Array;
    private readonly vertexOffsets?: Uint16Array | Uint32Array;
    private readonly topology: {
        geometryOffsets?: Uint16Array | Uint32Array;
        partOffsets?: Uint16Array | Uint32Array;
        ringOffsets?: Uint16Array | Uint32Array;
    };
    private readonly morton?: {numBits: number; coordinateShift: number};
    private readonly offsets: Uint32Array;
    private readonly containsPolygons: boolean;

    constructor(vector: GeometryVector | GpuVector) {
        if (!vector.topologyVector) throw new Error('Cannot read MLT geometry without topology information');
        this.types = new Uint8Array(vector.numGeometries);
        for (let i = 0; i < this.types.length; i++) {
            const type = vector.geometryType(i);
            if (type < 0 || type > GEOMETRY_TYPE.MULTIPOLYGON) throw new Error(`Unsupported MLT geometry type: ${type}`);
            this.types[i] = type;
        }
        const dictionary = vector instanceof GeometryVector && vector.vertexOffsets?.length;
        this.vertexOffsets = dictionary ? compactOffsets(vector.vertexOffsets) : undefined;
        this.morton = dictionary ? vector.mortonSettings : undefined;
        this.vertices = this.morton ? vector.vertexBuffer : compactCoordinates(vector.vertexBuffer);
        const topology = vector.topologyVector;
        this.topology = {
            geometryOffsets: compactOffsets(topology.geometryOffsets),
            partOffsets: compactOffsets(topology.partOffsets),
            ringOffsets: compactOffsets(topology.ringOffsets)
        };
        this.offsets = new Uint32Array((vector.numGeometries + 1) * 3);
        this.containsPolygons = false;
        for (let i = 0; i < vector.numGeometries; i++) {
            const type = vector.geometryType(i);
            if (type === GEOMETRY_TYPE.POLYGON || type === GEOMETRY_TYPE.MULTIPOLYGON) {
                this.containsPolygons = true;
                break;
            }
        }
        this.indexGeometry();
    }

    /** Indexes topology once; geometry and property objects are created only for requested features. */
    private indexGeometry(): void {
        const {geometryOffsets, partOffsets, ringOffsets} = this.topology;
        let part = 0;
        let ring = 0;
        let vertex = 0;
        for (let i = 0; i < this.types.length; i++) {
            this.offsets[i * 3] = part;
            this.offsets[i * 3 + 1] = ring;
            this.offsets[i * 3 + 2] = vertex;
            const type = this.geometryType(i);
            switch (type) {
                case GEOMETRY_TYPE.POINT:
                    vertex++;
                    if (partOffsets) part++;
                    if (ringOffsets) ring++;
                    break;
                case GEOMETRY_TYPE.MULTIPOINT: {
                    const count = geometryOffsets[i + 1] - geometryOffsets[i];
                    vertex += count;
                    part += count;
                    ring += count;
                    break;
                }
                case GEOMETRY_TYPE.LINESTRING:
                case GEOMETRY_TYPE.MULTILINESTRING: {
                    const count = type === GEOMETRY_TYPE.LINESTRING ? 1 : geometryOffsets[i + 1] - geometryOffsets[i];
                    vertex += this.containsPolygons
                        ? ringOffsets[ring + count] - ringOffsets[ring]
                        : partOffsets[part + count] - partOffsets[part];
                    if (this.containsPolygons) ring += count;
                    part += count;
                    break;
                }
                case GEOMETRY_TYPE.POLYGON:
                case GEOMETRY_TYPE.MULTIPOLYGON: {
                    const count = type === GEOMETRY_TYPE.POLYGON ? 1 : geometryOffsets[i + 1] - geometryOffsets[i];
                    const rings = partOffsets[part + count] - partOffsets[part];
                    vertex += ringOffsets[ring + rings] - ringOffsets[ring];
                    ring += rings;
                    part += count;
                    break;
                }
                default:
                    throw new Error(`Unsupported MLT geometry type: ${type}`);
            }
        }
        this.offsets.set([part, ring, vertex], this.types.length * 3);
    }

    geometryType(index: number): number {
        return this.types[index];
    }

    /** Morton dictionaries remain encoded and are read on demand. */
    private readPoint(index: number): Point {
        const offset = this.vertexOffsets ? this.vertexOffsets[index] : index;
        if (this.morton) {
            const {x, y} = decodeZOrderCurve(this.vertices[offset], this.morton.numBits, this.morton.coordinateShift);
            return new Point(x, y);
        }
        return new Point(this.vertices[offset * 2], this.vertices[offset * 2 + 1]);
    }

    /** Returns independent mutable points, including an independent closing point for polygon rings. */
    loadGeometry(index: number): Point[][] {
        const type = this.geometryType(index);
        const start = index * 3;
        let vertex = this.offsets[start + 2];
        const endVertex = this.offsets[start + 5];
        if (type === GEOMETRY_TYPE.POINT || type === GEOMETRY_TYPE.MULTIPOINT) {
            const points: Point[][] = [];
            for (; vertex < endVertex; vertex++) points.push([this.readPoint(vertex)]);
            return points;
        }
        if (type === GEOMETRY_TYPE.LINESTRING) return [this.readLine(vertex, endVertex, false)];

        const polygon = type === GEOMETRY_TYPE.POLYGON || type === GEOMETRY_TYPE.MULTIPOLYGON;
        const useRings = polygon || this.containsPolygons;
        const offset = useRings ? 1 : 0;
        const topology = this.topology;
        const boundaries = useRings ? topology.ringOffsets : topology.partOffsets;
        const lines: Point[][] = [];
        for (let line = this.offsets[start + offset]; line < this.offsets[start + 3 + offset]; line++) {
            const end = vertex + boundaries[line + 1] - boundaries[line];
            lines.push(this.readLine(vertex, end, polygon));
            vertex = end;
        }
        return lines;
    }

    /** Closes rings with a copy because extent scaling and overzooming mutate each returned point. */
    private readLine(start: number, end: number, close: boolean): Point[] {
        const points = new Array<Point>(end - start + (close && end > start ? 1 : 0));
        for (let vertex = start; vertex < end; vertex++) points[vertex - start] = this.readPoint(vertex);
        if (close && end > start) points[end - start] = points[0].clone();
        return points;
    }
}

/** Uses 16-bit storage only when every offset is representable without truncation. */
export function compactOffsets(values: Uint32Array | undefined): Uint16Array | Uint32Array | undefined {
    if (!values) return undefined;
    for (const value of values) if (value > 65535) return values;
    return Uint16Array.from(values);
}

/** Buffered tile coordinates may be negative or exceed the layer extent. */
export function compactCoordinates(values: Int32Array | Uint32Array): Int16Array | Int32Array | Uint32Array {
    for (const value of values) if (value < -32768 || value > 32767) return values;
    return Int16Array.from(values);
}
