import path from 'node:path';
import {fileURLToPath} from 'node:url';

import type {Plugin} from 'rolldown';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
/** The package ships TypeScript sources so the profile can exclude clustering without replacing its tiler. */
const geojsonSourceRoot = fileURLToPath(new URL('../src/', import.meta.resolve('@maplibre/geojson-vt')));
const styleSpecRoot = fileURLToPath(new URL('./', import.meta.resolve('@maplibre/maplibre-gl-style-spec')));
const workerModule = 'skysight:worker-url';

/** Modules excluded from the SkySight renderer. Unsupported source and layer types fail explicitly. */
const excludedModules: Record<string, string> = {
    'source/video_source.ts': 'export class VideoSource { constructor() { throw new Error("Video sources are not included in the SkySight renderer"); } }',
    'style/style_layer/heatmap_style_layer.ts': 'export class HeatmapStyleLayer { constructor() { throw new Error("Heatmaps are not included in the SkySight renderer"); } } export function isHeatmapStyleLayer() { return false; }',
    'style/style_layer/fill_extrusion_style_layer.ts': 'export class FillExtrusionStyleLayer { constructor() { throw new Error("Fill extrusions are not included in the SkySight renderer"); } } export function isFillExtrusionStyleLayer() { return false; }',
    'webgl/draw/draw_heatmap.ts': 'export function drawHeatmap() { throw new Error("Heatmaps are not included in the SkySight renderer"); }',
    'webgl/draw/draw_fill_extrusion.ts': 'export function drawFillExtrusion() { throw new Error("Fill extrusions are not included in the SkySight renderer"); }',
    'webgl/program/heatmap_program.ts': 'function excluded() { throw new Error("Heatmaps are not included in the SkySight renderer"); } export {excluded as heatmapUniforms, excluded as heatmapTextureUniforms, excluded as heatmapUniformValues, excluded as heatmapTextureUniformValues};',
    'webgl/program/fill_extrusion_program.ts': 'function excluded() { throw new Error("Fill extrusions are not included in the SkySight renderer"); } export {excluded as fillExtrusionUniforms, excluded as fillExtrusionPatternUniforms, excluded as fillExtrusionUniformValues, excluded as fillExtrusionPatternUniformValues};',
    'source/projection_handler_worker.ts': 'function excluded() { throw new Error("Custom projections are not included in the SkySight renderer"); } export {excluded as createWorkerCRSHelper, excluded as setProjectionHandler};',
    'util/geojson_reproject.ts': 'function excluded() { throw new Error("Custom projections are not included in the SkySight renderer"); } export {excluded as reprojectGeoJSONToWorld, excluded as reprojectGeoJSONFromWorld, excluded as reprojectGeoJSONSourceDiffToWorld};',
    'render/font_face_manager.ts': `export class FontFaceManager {
        setFontFaces(value) { if (value && Object.keys(value).length) throw new Error("Font faces are not included in the SkySight renderer"); }
        hasFontFaces() { return false; }
        async getFontFamily() { return null; }
        destroy() {}
    }`,
    'webgl/draw/draw_debug.ts': 'function excluded() { throw new Error("Debug overlays are not included in the SkySight renderer"); } export {excluded as drawDebug, excluded as drawDebugPadding}; export function selectDebugSource() { return null; }',
    'webgl/draw/draw_collision_debug.ts': 'export function drawCollisionDebug() { throw new Error("Debug overlays are not included in the SkySight renderer"); }',
};

/**
 * Emits a content-addressed module graph and a manifest for the app's asset pipeline.
 * The worker URL is a Rollup file reference, so worker or shared-code changes also change its importers' hashes.
 * Feature exclusions apply to this build only; the normal upstream build and unit tests retain all features.
 */
export function skysightBuild(): Plugin {
    return {
        name: 'skysight-renderer',
        resolveId(source) {
            if (source === workerModule) return `\0${workerModule}`;
            if (source === '@maplibre/geojson-vt') return path.join(geojsonSourceRoot, 'index.ts');
        },
        load(id) {
            if (id === `\0${workerModule}`) {
                const ref = this.emitFile({type: 'chunk', id: path.join(sourceRoot, 'source/worker.ts'), name: 'maplibre-gl-worker'});
                return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
            }
            if (id === path.join(geojsonSourceRoot, 'cluster-tile-index.ts')) {
                return 'export const defaultClusterOptions = {}; export class ClusterTileIndex { constructor() { throw new Error("GeoJSON clustering is not included in the SkySight renderer"); } }';
            }
            const expression = path.relative(styleSpecRoot, id).replaceAll(path.sep, '/');
            if (/^expression\/definitions\/(distance|within)\.mjs$/.test(expression)) {
                const name = expression.endsWith('/distance.mjs') ? 'Distance' : 'Within';
                return `export class ${name} { static parse(_args, context) { return context.error("${name} expressions are not included in the SkySight renderer"); } }`;
            }
            const relative = path.relative(sourceRoot, id).replaceAll(path.sep, '/');
            if (relative === 'geo/projection/projection_factory.ts') {
                return `export {createProjectionFromName} from ${JSON.stringify(path.join(sourceRoot, 'skysight/projection_factory.ts'))};`;
            }
            if (relative in excludedModules) return excludedModules[relative];
            if (/^shaders\/glsl\/(heatmap|heatmap_texture|fill_extrusion|fill_extrusion_pattern|_projection_globe|atmosphere|debug|collision_box|collision_circle)\.(vertex|fragment)\.glsl\.g\.ts$/.test(relative)) {
                return 'export default "";';
            }
        },
        generateBundle(_options, bundle) {
            const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
            const main = chunks.find(chunk => chunk.name === 'maplibre-gl');
            const worker = chunks.find(chunk => chunk.name === 'maplibre-gl-worker');
            if (!main || !worker) throw new Error('SkySight main and worker entries must both be emitted');
            this.emitFile({
                type: 'asset',
                fileName: 'manifest.json',
                source: JSON.stringify({main: main.fileName, worker: worker.fileName, files: chunks.map(chunk => chunk.fileName)}, null, 2)
            });
        }
    };
}
