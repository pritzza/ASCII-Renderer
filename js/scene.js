// js/scene.js
import { vec3, add, normalize, transformPoint, rotationMatrixY, rotationMatrixX } from './utils.js';

function generateCubeGeometry() {
    const v = [
        vec3(-0.5, -0.5, -0.5), vec3(0.5, -0.5, -0.5), vec3(0.5, 0.5, -0.5), vec3(-0.5, 0.5, -0.5),
        vec3(-0.5, -0.5, 0.5), vec3(0.5, -0.5, 0.5), vec3(0.5, 0.5, 0.5), vec3(-0.5, 0.5, 0.5),
    ];
    const triangles = [
        { v0: 0, v1: 1, v2: 2 }, { v0: 0, v1: 2, v2: 3 }, { v0: 4, v1: 6, v2: 5 }, { v0: 4, v1: 7, v2: 6 },
        { v0: 3, v1: 2, v2: 6 }, { v0: 3, v1: 6, v2: 7 }, { v0: 0, v1: 4, v2: 1 }, { v0: 1, v1: 4, v2: 5 },
        { v0: 1, v1: 5, v2: 6 }, { v0: 1, v1: 6, v2: 2 }, { v0: 0, v1: 3, v2: 7 }, { v0: 0, v1: 7, v2: 4 },
    ];
    return { vertices: v, triangles };
}

export function createScene() {
    const cubeGeometry = generateCubeGeometry();
    return [
        {
            name: 'center_sphere',
            type: 'sphere',
            position: vec3(0, 0, 0),
            geometry: { radius: 1.0 },
            material: { shadingType: 'emissive', color: vec3(1.0, 1.0, 0.8) },
            isLight: true,
            animation: (time, obj) => {
                obj.position = vec3(0, 0, Math.sin(time * 0.5) * 2.0);
            }
        },
        {
            name: 'left_cube',
            type: 'mesh',
            position: vec3(-1.8, 0, 0),
            geometry: cubeGeometry,
            transformedVertices: cubeGeometry.vertices,
            animation: (time, obj) => {
                const rotMatrix = rotationMatrixY(time);
                obj.transformedVertices = obj.geometry.vertices.map(v => add(transformPoint(v, rotMatrix), obj.position));
            }
        },
        {
            name: 'right_cube',
            type: 'mesh',
            position: vec3(1.8, 0, 0),
            geometry: cubeGeometry,
            transformedVertices: cubeGeometry.vertices,
            animation: (time, obj) => {
                const rotMatrix = rotationMatrixX(time * 0.7);
                obj.transformedVertices = obj.geometry.vertices.map(v => add(transformPoint(v, rotMatrix), obj.position));
            }
        },
        {
            name: 'floor',
            type: 'sphere',
            position: vec3(0, -201, 0),
            geometry: { radius: 200 },
            material: { shadingType: 'diffuse', albedo: vec3(0.8, 0.8, 1.0) }
        }
    ];
}