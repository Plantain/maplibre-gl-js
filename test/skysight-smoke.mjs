import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {brotliCompressSync, constants, gzipSync} from 'node:zlib';
import puppeteer from 'puppeteer';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const timeout = setTimeout(() => { console.error('SkySight browser smoke timed out'); process.exit(1); }, 45000);
const directory = path.join(root, 'dist/skysight');
const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json')));
const sizes = [];
for (const file of manifest.files) {
    const content = await readFile(path.join(directory, file));
    const references = [...content.toString().matchAll(/(?:from|import)\s*["']\.\/([^"']+)["']/g)].map(match => match[1]);
    for (const reference of references) assert.ok(manifest.files.includes(reference), `Missing module: ${reference}`);
    const map = JSON.parse(await readFile(path.join(directory, `${file}.map`)));
    assert.ok(!map.sources.some(source => /globe_transform|vertical_perspective_transform|heatmap_bucket|fill_extrusion_bucket|fullscreen_control|globe_control|terrain_control|geojson-vt\/dist\//.test(source)), 'Excluded modules reached the bundle');
    assert.ok(!map.sources.some(source => /geojson-vt\/node_modules\/kdbush/.test(source)), 'The tiler bundled a duplicate spatial index');
    sizes.push({file, bytes: content.length, gzip: gzipSync(content).length, brotli: brotliCompressSync(content, {params: {[constants.BROTLI_PARAM_QUALITY]: 11}}).length});
}
const main = await readFile(path.join(directory, manifest.main), 'utf8');
const worker = await readFile(path.join(directory, manifest.worker), 'utf8');
const shared = manifest.files.filter(file => file !== manifest.main && file !== manifest.worker);
assert.equal(shared.length, 1);
assert.ok(main.includes(manifest.worker));
assert.ok(main.includes(shared[0]) && worker.includes(shared[0]));

const tileAcceptHeaders = [];
const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname === '/') {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><div id="map" style="width:256px;height:256px"></div>');
            return;
        }
        const file = path.resolve(root, `.${pathname}`);
        if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Invalid path');
        await stat(file);
        if (/\.(mlt|mvt)$/.test(file)) tileAcceptHeaders.push(request.headers.accept);
        response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream');
        response.end(await readFile(file));
    } catch {
        response.writeHead(404).end();
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
    browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH,
        headless: true,
        args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader']
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    const result = await page.evaluate(async ({manifest, moduleUrl, dataLayerUrl}) => {
        const lib = await import(moduleUrl || `/dist/skysight/${manifest.main}`);
        if (dataLayerUrl) {
            const dataLayer = await import(dataLayerUrl);
            if (!dataLayer.mapLibreRasterSupportsPremultiplyOption(lib)) throw new Error('Forecast data layer does not recognize raw raster support');
        }
        const mapErrors = [];
        const excluded = [];
        const map = new lib.Map({container: 'map', center: [73, 36], zoom: 5.99, canvasContextAttributes: {preserveDrawingBuffer: true}, style: {
            version: 8,
            glyphs: `${location.origin}/test/integration/assets/glyphs/{fontstack}/{range}.pbf`,
            sources: {mlt: {type: 'vector', encoding: 'mlt', tiles: [`${location.origin}/test/integration/assets/tiles/mlt/5/22/12.mlt`], minzoom: 5, maxzoom: 5}},
            layers: [{id: 'land', type: 'fill', source: 'mlt', 'source-layer': 'landcover', paint: {'fill-color': '#008000'}}]
        }});
        map.on('error', event => {
            const message = event.error.message;
            if (message.includes('not included in the SkySight renderer')) excluded.push(message);
            else mapErrors.push(message);
        });
        await map.once('idle');
        const features = map.queryRenderedFeatures().length;
        if (!features) throw new Error('MLT worker did not render features');
        map.addSource('fallback', {type: 'vector', encoding: 'mlt', tiles: [`${location.origin}/test/integration/assets/tiles/ocean.mvt`], minzoom: 5, maxzoom: 5});
        map.addLayer({id: 'fallback', type: 'fill', source: 'fallback', 'source-layer': 'water', paint: {'fill-opacity': 0.1}});
        await map.once('idle');
        if (!map.queryRenderedFeatures({layers: ['fallback']}).length) throw new Error('MVT fallback did not render');
        if (!map.querySourceFeatures('fallback', {sourceLayer: 'water'}).length) throw new Error('MVT fallback source query failed');
        map.setFilter('fallback', ['==', ['geometry-type'], 'Polygon']);
        await map.once('idle');
        if (!map.queryRenderedFeatures({layers: ['fallback']}).length) throw new Error('MVT fallback reload lost its encoding');
        map.removeLayer('fallback');
        map.removeSource('fallback');
        map.addSource('geojson', {type: 'geojson', data: {type: 'Feature', id: 1, properties: {}, geometry: {type: 'Point', coordinates: [73, 36]}}});
        map.addLayer({id: 'point', type: 'circle', source: 'geojson', paint: {'circle-radius': 10, 'circle-color': '#ff0000'}});
        await map.once('idle');
        if (!map.queryRenderedFeatures({layers: ['point']}).length) throw new Error('GeoJSON worker failed');
        map.addLayer({id: 'label', type: 'symbol', source: 'geojson', layout: {'text-field': 'SkySight', 'text-font': ['Noto Sans Regular']}});
        await map.once('idle');
        if (!map.queryRenderedFeatures({layers: ['label']}).length) throw new Error('Labels did not render');
        const geojson = map.getSource('geojson');
        await geojson.setData({type: 'Feature', id: 1, properties: {stage: 'replaced'}, geometry: {type: 'Point', coordinates: [73.1, 36]}});
        await map.once('idle');
        if (!map.queryRenderedFeatures({layers: ['point']}).some(feature => feature.properties.stage === 'replaced')) throw new Error('GeoJSON setData failed');
        await geojson.updateData({update: [{id: 1, newGeometry: {type: 'Point', coordinates: [73, 36]}, addOrUpdateProperties: [{key: 'stage', value: 'updated'}]}]});
        await map.once('idle');
        if (!map.queryRenderedFeatures({layers: ['point']}).some(feature => feature.properties.stage === 'updated')) throw new Error('GeoJSON updateData failed');
        if (!map.querySourceFeatures('geojson').some(feature => feature.properties.stage === 'updated')) throw new Error('GeoJSON source query failed');

        const polygon = {type: 'Polygon', coordinates: [
            [[72, 35], [74, 35], [74, 37], [72, 37], [72, 35]],
            [[72.8, 35.8], [72.8, 36.2], [73.2, 36.2], [73.2, 35.8], [72.8, 35.8]]
        ]};
        map.addSource('polygon', {type: 'geojson', data: {type: 'Feature', properties: {}, geometry: polygon}});
        map.addLayer({id: 'polygon', type: 'fill', source: 'polygon'});
        await map.once('idle');
        if (!map.queryRenderedFeatures(map.project([73.5, 36]), {layers: ['polygon']}).length) throw new Error('GeoJSON polygon did not render');
        if (map.queryRenderedFeatures(map.project([73, 36]), {layers: ['polygon']}).length) throw new Error('GeoJSON polygon hole was filled');
        map.removeLayer('polygon');
        map.removeSource('polygon');

        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d');
        context.fillStyle = '#0000ff';
        context.fillRect(0, 0, 256, 256);
        map.addSource('canvas', {type: 'canvas', canvas, animate: false, coordinates: [[70, 39], [76, 39], [76, 33], [70, 33]]});
        map.addLayer({id: 'canvas', type: 'raster', source: 'canvas'});
        map.addSource('raw', {type: 'raster', tiles: [canvas.toDataURL()], tileSize: 256, premultiply: false});
        const raster = map.getSource('raw');
        raster.setRequestPriority('preload');
        if (raster.getRequestPriority() !== 'preload') throw new Error('Missing request priority API');
        raster.setRequestPriority('normal');
        map.addLayer({id: 'raw', type: 'raster', source: 'raw'});
        await map.once('idle');
        map.addSource('dem', {type: 'raster-dem', tiles: [`${location.origin}/test/integration/assets/tiles/zero-elevation-terrain-tile.png`], tileSize: 256, maxzoom: 0});
        map.addLayer({id: 'hillshade', type: 'hillshade', source: 'dem'});
        map.addLayer({id: 'relief', type: 'color-relief', source: 'dem'});
        map.setTerrain({source: 'dem'});
        await map.once('idle');
        if (!map.getTerrain()) throw new Error('Terrain unavailable');
        let customFrames = 0;
        map.addLayer({id: 'custom', type: 'custom', renderingMode: '3d', render(_gl, options) {
            if (!options.defaultProjectionData.mainMatrix || !options.getProjectionData) throw new Error('Custom render API unavailable');
            customFrames++;
        }});
        await map.once('idle');
        if (!customFrames) throw new Error('Custom layer did not render');
        map.setTerrain(null);
        for (const type of ['heatmap', 'fill-extrusion']) {
            try { map.addLayer({id: `excluded-${type}`, type, source: 'geojson'}); }
            catch (error) { excluded.push(error.message); }
        }
        try { map.setProjection({type: 'globe'}); } catch (error) { excluded.push(error.message); }
        try { map.setFontFaces({'Noto Sans Regular': [{url: '/unused.woff2'}]}); } catch (error) { excluded.push(error.message); }
        map.setFontFaces(null);
        map.addLayer({id: 'excluded-distance', type: 'circle', source: 'geojson', paint: {'circle-radius': ['distance', {type: 'Point', coordinates: [73, 36]}]}});
        map.addLayer({id: 'excluded-within', type: 'circle', source: 'geojson', filter: ['within', polygon]});
        const clusterError = map.once('error');
        map.addSource('excluded-cluster', {type: 'geojson', cluster: true, data: {type: 'FeatureCollection', features: []}});
        await clusterError;
        map.removeSource('excluded-cluster');
        map.remove();
        return {version: lib.getVersion(), worker: lib.getWorkerUrl(), features, customFrames, mapErrors, excluded};
    }, {manifest, moduleUrl: process.env.MAPLIBRE_MODULE_URL, dataLayerUrl: process.env.MAPLIBRE_DATA_LAYER_URL});
    assert.deepEqual(errors, []);
    assert.deepEqual(result.mapErrors, []);
    assert.ok(tileAcceptHeaders.length >= 2);
    for (const accept of tileAcceptHeaders) {
        assert.equal(accept, 'application/vnd.maplibre-tile, application/vnd.mapbox-vector-tile;q=0.9');
    }
    assert.equal(result.excluded.length, 7);
    for (const feature of ['Heatmaps', 'Fill extrusions', 'Only Mercator', 'Font faces', 'Distance expressions', 'Within expressions', 'GeoJSON clustering']) {
        assert.ok(result.excluded.some(message => message.includes(feature)), `Missing exclusion error: ${feature}`);
    }
    assert.ok(result.worker.endsWith(manifest.worker));
    console.log(JSON.stringify({result, sizes, total: sizes.reduce((total, item) => ({bytes: total.bytes + item.bytes, gzip: total.gzip + item.gzip, brotli: total.brotli + item.brotli}), {bytes: 0, gzip: 0, brotli: 0})}, null, 2));
} finally {
    clearTimeout(timeout);
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
