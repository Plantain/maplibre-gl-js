import {defineConfig, type RolldownOptions} from 'rolldown';
import banner from './build/banner.ts';
import {skysightBuild} from './build/skysight.ts';

const config: RolldownOptions = defineConfig({
    input: {'maplibre-gl': 'src/skysight/index.ts'},
    platform: 'browser',
    treeshake: true,
    plugins: [skysightBuild()],
    output: {
        dir: 'dist/skysight',
        format: 'es',
        sourcemap: true,
        minify: true,
        banner,
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: chunk => `${chunk.name === 'maplibre-gl-worker' ? 'maplibre-gl-worker' : 'maplibre-gl-shared'}-[hash].js`,
    }
});

export default config;
