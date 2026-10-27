import {describe, expect, test, vi} from 'vitest';
import {StyleExpression, createExpression} from '@maplibre/maplibre-gl-style-spec';
import {installExpressionContextCleanup} from './expression_context.ts';
import {CanonicalTileID} from '../tile/tile_id.ts';

import type {Expression, EvaluationContext} from '@maplibre/maplibre-gl-style-spec';

installExpressionContextCleanup();

describe('expression input lifetime', () => {
    test.each(['evaluate', 'evaluateWithoutErrorHandling'] as const)('releases %s inputs after success and errors', method => {
        let captured: EvaluationContext;
        const expression = new StyleExpression({
            evaluate(context) {
                captured = context;
                if (context.properties().fail) throw new Error('test failure');
                expect(context.geometry()).toEqual([[{x: 1, y: 2}]]);
                return context.properties().value;
            }
        } as Expression, 'test');
        const feature = {type: 1 as const, properties: {value: 7}, geometry: [[{x: 1, y: 2}]]};
        expect(expression[method]({zoom: 0}, feature, {selected: true}, new CanonicalTileID(0, 0, 0), ['icon'])).toBe(7);
        expect([captured.feature, captured.featureState, captured.globals, captured.canonical,
            captured.availableImages, captured.formattedSection]).toEqual([null, null, null, null, null, null]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            let outcome: unknown;
            try {
                outcome = expression[method]({zoom: 1}, {type: 1, properties: {fail: true}});
            } catch (error) {
                outcome = error.message;
            }
            expect(outcome).toBe(method === 'evaluate' ? null : 'test failure');
            expect(captured.feature).toBeNull();
            expect(captured.globals).toBeNull();
        } finally {
            warn.mockRestore();
        }
    });

    test('restores the outer feature and globals when the same expression is evaluated reentrantly', () => {
        let captured: EvaluationContext;
        const expression = new StyleExpression({
            evaluate(context) {
                captured = context;
                if (context.properties().inner) return context.globals.zoom;
                expect(expression.evaluateWithoutErrorHandling({zoom: 9}, {type: 1, properties: {inner: true}})).toBe(9);
                return context.properties().value + context.globals.zoom;
            }
        } as Expression, 'test');
        expect(expression.evaluate({zoom: 2}, {type: 1, properties: {value: 5}})).toBe(7);
        expect(captured.feature).toBeNull();
        expect(captured.globals).toBeNull();
    });

    test('compiled expressions continue to read properties, feature state, IDs and globals across calls', () => {
        const compiled = createExpression(['+', ['number', ['get', 'value']], ['number', ['feature-state', 'offset']], ['number', ['id']], ['zoom']], 'test');
        expect(compiled.result).toBe('success');
        if (compiled.result !== 'success') return;
        expect(compiled.value.evaluate({zoom: 1}, {id: 2, type: 1, properties: {value: 3}}, {offset: 4})).toBe(10);
        expect(compiled.value.evaluate({zoom: 5}, {id: 6, type: 1, properties: {value: 7}}, {offset: 8})).toBe(26);
    });
});
