import {StyleExpression} from '@maplibre/maplibre-gl-style-spec';

type Context = StyleExpression['_evaluator'];
type Inputs = Pick<Context, 'globals' | 'feature' | 'featureState' | 'canonical' | 'availableImages' | 'formattedSection'>;
const active = new WeakSet<StyleExpression>();
const emptyInputs: Inputs = {
    globals: null, feature: null, featureState: null, canonical: null, availableImages: null, formattedSection: null
};
let installed = false;

/**
 * Keeps style-spec's reusable evaluation contexts from retaining tile features between calls.
 * Both evaluation entry points release their transient inputs on success or error. Reentrant
 * evaluations restore the outer call's inputs; the color cache remains reusable.
 */
export function installExpressionContextCleanup(): void {
    if (installed) return;
    installed = true;
    for (const method of ['evaluate', 'evaluateWithoutErrorHandling'] as const) {
        const evaluate = StyleExpression.prototype[method];
        StyleExpression.prototype[method] = function (...args: Parameters<typeof evaluate>) {
            const context = this._evaluator;
            const previous = active.has(this) ? captureInputs(context) : null;
            active.add(this);
            try {
                return evaluate.apply(this, args);
            } finally {
                if (!previous) active.delete(this);
                restoreInputs(context, previous || emptyInputs);
            }
        };
    }
}

/** Restores outer inputs or clears a completed top-level evaluation. */
function restoreInputs(context: Context, inputs: Inputs): void {
    context.globals = inputs.globals;
    context.feature = inputs.feature;
    context.featureState = inputs.featureState;
    context.canonical = inputs.canonical;
    context.availableImages = inputs.availableImages;
    context.formattedSection = inputs.formattedSection;
}

/** Snapshots only the inputs that an inner evaluation can overwrite. */
function captureInputs(context: Context): Inputs {
    return {
        globals: context.globals, feature: context.feature, featureState: context.featureState,
        canonical: context.canonical, availableImages: context.availableImages, formattedSection: context.formattedSection
    };
}
