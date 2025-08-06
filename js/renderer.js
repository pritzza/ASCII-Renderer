import { config } from './config.js';
import { vec3, add, sub, scale, normalize, cross, dot, createBuffer, lerp } from './utils.js';
import { camera } from './camera.js';
import { intersectSphere, intersectTriangle } from './geometry.js';

function packColor(r, g, b) {
    return (r << 16) | (g << 8) | b;
}

function traceRay(rayOrigin, rayDir, scene, depth) {
    if (depth <= 0) { return vec3(0, 0, 0); }
    let closest_t = Infinity, hitNormal = null, hitObject = null;
    for (const obj of scene) {
        if (obj.type === 'sphere') {
            const t = intersectSphere(rayOrigin, rayDir, obj.position, obj.geometry.radius);
            if (t > 0 && t < closest_t) { hitNormal = normalize(sub(add(rayOrigin, scale(rayDir, t)), obj.position)); closest_t = t; hitObject = obj; }
        } else if (obj.type === 'mesh') {
            for (const tri of obj.geometry.triangles) {
                const v0 = obj.transformedVertices[tri.v0], v1 = obj.transformedVertices[tri.v1], v2 = obj.transformedVertices[tri.v2];
                const t = intersectTriangle(rayOrigin, rayDir, v0, v1, v2);
                if (t > 0 && t < closest_t) { hitNormal = normalize(cross(sub(v1, v0), sub(v2, v0))); closest_t = t; hitObject = obj; }
            }
        }
    }
    if (hitObject) {
        const material = hitObject.material || {}; const hitPoint = add(rayOrigin, scale(rayDir, closest_t));
        switch (material.shadingType) {
            case 'emissive': return material.color;
            case 'diffuse': {
                let totalLight = vec3(); const lightSources = scene.filter(obj => obj.isLight);
                for (const light of lightSources) {
                    const lightDir = normalize(sub(light.position, hitPoint)); const lightDist = Math.sqrt(dot(sub(light.position, hitPoint), sub(light.position, hitPoint)));
                    const shadowRayOrigin = add(hitPoint, scale(hitNormal, config.EPSILON)); let inShadow = false;
                    for (const obj of scene) {
                        if (obj === light || obj === hitObject) continue;
                        let t_shadow = -1;
                        if (obj.type === 'sphere') { t_shadow = intersectSphere(shadowRayOrigin, lightDir, obj.position, obj.geometry.radius); }
                        else if (obj.type === 'mesh') { for (const tri of obj.geometry.triangles) { t_shadow = intersectTriangle(shadowRayOrigin, lightDir, obj.transformedVertices[tri.v0], obj.transformedVertices[tri.v1], obj.transformedVertices[tri.v2]); if (t_shadow > 0 && t_shadow < lightDist) { inShadow = true; break; } } }
                        if (inShadow) break;
                        if (t_shadow > 0 && t_shadow < lightDist) { inShadow = true; break; }
                    }
                    if (!inShadow) { const diffuseIntensity = Math.max(0, dot(hitNormal, lightDir)); const lightContribution = scale(light.material.color, diffuseIntensity); totalLight = add(totalLight, lightContribution); }
                }
                return { x: material.albedo.x * totalLight.x, y: material.albedo.y * totalLight.y, z: material.albedo.z * totalLight.z };
            }
            default: { const reflectDir = sub(rayDir, scale(hitNormal, 2 * dot(rayDir, hitNormal))); const reflectOrigin = add(hitPoint, scale(hitNormal, config.EPSILON)); return traceRay(reflectOrigin, reflectDir, scene, depth - 1); }
        }
    }
    const t = 0.5 * (rayDir.y + 1.0); const horizonColor = vec3(0.1, 0.2, 0.4); const zenithColor = vec3(0.5, 0.7, 1.0);
    return lerp(horizonColor, zenithColor, t);
}


export function renderScene(time, framebuffer, state) {
    const { cols, rows, scene, charWidth, charHeight } = state;
    scene.forEach(obj => { if (obj.animation) obj.animation(time, obj); });
    const forward = normalize(vec3(Math.cos(camera.yaw) * Math.cos(camera.pitch), Math.sin(camera.pitch), Math.sin(camera.yaw) * Math.cos(camera.pitch)));
    const right = normalize(cross(forward, vec3(0, 1, 0)));
    const up = normalize(cross(right, forward));
    const pixelAspectRatio = (cols * charWidth) / (rows * charHeight);

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const u = (x / cols * 2.0 - 1.0);
            const v = (y / rows * 2.0 - 1.0) * -1.0;
            const correctedU = u * pixelAspectRatio;
            const rayDir = normalize(add(scale(right, correctedU), add(scale(up, v), forward)));
            const finalColor = traceRay(camera.pos, rayDir, scene, config.MAX_BOUNCES);
            const i = (y * cols + x) * 4;
            framebuffer[i] = finalColor.x * 255;
            framebuffer[i + 1] = finalColor.y * 255;
            framebuffer[i + 2] = finalColor.z * 255;
            framebuffer[i + 3] = 255;
        }
    }
}

export function compositeAndQuantize(state) {
    const { cols, rows, framebuffer, uiBuffer, dataBuffer_chars, dataBuffer_colors } = state;
    
    // **FIXED**: The number of color levels is now correctly tied to the ASCII ramp length.
    const numColorBands = config.ASCII_RAMP.length;

    const quantize = (val) => {
        const bandIndex = Math.round((val / 255) * (numColorBands - 1));
        return Math.round((bandIndex / (numColorBands - 1)) * 255);
    };

    const blackPacked = packColor(0, 0, 0);

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            const uiChar = uiBuffer[y][x];

            if (uiChar !== null) {
                dataBuffer_chars[i] = uiChar.charCodeAt(0);
                dataBuffer_colors[i] = blackPacked;
            } else {
                const fb_i = i * 4;
                const r_raw = framebuffer[fb_i];
                const g_raw = framebuffer[fb_i + 1];
                const b_raw = framebuffer[fb_i + 2];

                let r_quantized, g_quantized, b_quantized, intensity;

                if (config.USE_GRAYSCALE) {
                    intensity = (r_raw + g_raw + b_raw) / 3;
                    //r_quantized = g_quantized = b_quantized = quantize(intensity);
                    r_quantized = g_quantized = b_quantized = 1;
                } else {
                    r_quantized = quantize(r_raw);
                    g_quantized = quantize(g_raw);
                    b_quantized = quantize(b_raw);
                    intensity = (r_quantized + g_quantized + b_quantized) / 3;
                }
                
                const charIndex = Math.floor((intensity / 255) * (config.ASCII_RAMP.length - 1));
                
                dataBuffer_chars[i] = config.ASCII_RAMP[charIndex].charCodeAt(0);
                dataBuffer_colors[i] = packColor(r_quantized, g_quantized, b_quantized);
            }
        }
    }
}

function setPointOnBuffer(buffer, x, y, char, state) {
    const { cols, rows } = state;
    if (x >= 0 && x < cols && y >= 0 && y < rows) {
        buffer[y][x] = char;
    }
}

function drawCircleOnBuffer(buffer, cx, cy, r, char, state) {
    cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
    let x = r, y = 0, err = 0;
    while (x >= y) {
        setPointOnBuffer(buffer, cx + x, cy + y, char, state);
        setPointOnBuffer(buffer, cx + y, cy + x, char, state);
        setPointOnBuffer(buffer, cx - y, cy + x, char, state);
        setPointOnBuffer(buffer, cx - x, cy + y, char, state);
        setPointOnBuffer(buffer, cx - x, cy - y, char, state);
        setPointOnBuffer(buffer, cx - y, cy - x, char, state);
        setPointOnBuffer(buffer, cx + y, cy - x, char, state);
        setPointOnBuffer(buffer, cx + x, cy - y, char, state);
        if (err <= 0) { y++; err += 2*y+1; }
        if (err > 0) { x--; err -= 2*x+1; }
    }
}

export function renderUI(fps, state) {
    const { cols, rows, uiEffects, time } = state;
    state.uiBuffer = createBuffer(cols, rows, null);

    for (let x = 0; x < cols; x++) {
        setPointOnBuffer(state.uiBuffer, x, 0, config.PI_DIGITS[x % config.PI_DIGITS.length], state);
        setPointOnBuffer(state.uiBuffer, x, rows - 1, config.PI_DIGITS[x % config.PI_DIGITS.length], state);
    }
    for (let y = 0; y < rows; y++) {
        setPointOnBuffer(state.uiBuffer, 0, y, config.PI_DIGITS[y % config.PI_DIGITS.length], state);
        setPointOnBuffer(state.uiBuffer, cols - 1, y, config.PI_DIGITS[y % config.PI_DIGITS.length], state);
    }

    const fpsString = String(fps);
    const startX = cols - fpsString.length - 1;
    const startY = rows - 1;
    for (let i = 0; i < fpsString.length; i++) {
        if (startX + i < cols && startY >= 0) {
            state.uiBuffer[startY][startX + i] = fpsString[i];
        }
    }

    if (uiEffects) {
        for (const effect of uiEffects) {
            if (effect.type === 'ripple') {
                const age = time - effect.startTime;
                const radius = age * config.RIPPLE_SPEED;
                drawCircleOnBuffer(state.uiBuffer, effect.center.x, effect.center.y, radius, '*', state);
            }
        }
    }
}