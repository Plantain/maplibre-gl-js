import {MercatorProjection} from '../geo/projection/mercator_projection.ts';
import {createMercatorTransform} from '../geo/projection/mercator_transform.ts';
import {MercatorCameraHelper} from '../geo/projection/mercator_camera_helper.ts';

import type {ProjectionSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {Projection} from '../geo/projection/projection.ts';
import type {ITransform, TransformConstrainFunction} from '../geo/transform_interface.ts';
import type {ICameraHelper} from '../geo/projection/camera_helper.ts';

/** SkySight uses a Mercator world, including when its layers are draped over 3D terrain. */
export function createProjectionFromName(name: ProjectionSpecification['type'], transformConstrain: TransformConstrainFunction | undefined): {
    projection: Projection;
    transform: ITransform;
    cameraHelper: ICameraHelper;
} {
    if (name !== 'mercator') throw new Error('Only Mercator projection is included in the SkySight renderer');
    return {
        projection: new MercatorProjection(),
        transform: createMercatorTransform({constrainOverride: transformConstrain}),
        cameraHelper: new MercatorCameraHelper(),
    };
}
