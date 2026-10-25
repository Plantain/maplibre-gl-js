import {test, expect} from 'vitest';
import {rolldown, type OutputChunk, type Plugin} from 'rolldown';
import config from '../../rolldown.config.skysight.ts';

/** Builds in memory so cache-coherence tests never replace the app's current asset graph. */
async function buildGraph(changedModule?: string): Promise<Record<string, OutputChunk>> {
    const change: Plugin = {
        name: 'cache-invalidation-fixture',
        transform(code, id) {
            if (changedModule && id.endsWith(changedModule)) {
                return `${code}\nself.__skysightCacheTest = ${JSON.stringify(changedModule)};`;
            }
        }
    };
    const bundle = await rolldown({...config, plugins: [...config.plugins as Plugin[], change]});
    try {
        const {output} = await bundle.generate(config.output);
        return Object.fromEntries(output.filter(item => item.type === 'chunk').map(chunk => [chunk.name, chunk]));
    } finally {
        await bundle.close();
    }
}

test('worker and shared-code changes invalidate the importing main URL', async () => {
    const original = await buildGraph();
    const workerChanged = await buildGraph('/src/source/worker.ts');
    const sharedChanged = await buildGraph('/src/util/config.ts');
    for (const changed of [workerChanged, sharedChanged]) {
        expect(changed['maplibre-gl'].fileName).not.toBe(original['maplibre-gl'].fileName);
        expect(changed['maplibre-gl-worker'].fileName).not.toBe(original['maplibre-gl-worker'].fileName);
        expect(changed['maplibre-gl'].code).toContain(changed['maplibre-gl-worker'].fileName);
    }
    const sharedName = Object.keys(original).find(name => name !== 'maplibre-gl' && name !== 'maplibre-gl-worker');
    expect(workerChanged[sharedName].fileName).toBe(original[sharedName].fileName);
    expect(sharedChanged[sharedName].fileName).not.toBe(original[sharedName].fileName);
}, 30000);
