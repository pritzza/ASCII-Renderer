// js/render/backends/raster_shader.js
// GLSL sources for the WebGL1 forward raster backend.
// Matches path tracer camera mapping + pixel-aspect handling via projection.

const MAX_POINT_LIGHTS = 8;

export function buildRasterSources() {
  const vs = `
attribute vec3 a_pos;
attribute vec3 a_nrm;
attribute vec3 a_col;
uniform mat4 uProj;
uniform mat4 uView;
varying vec3 v_nrm;
varying vec3 v_col;
varying vec3 v_pos;
void main(){
  v_nrm = a_nrm;
  v_col = a_col;
  v_pos = a_pos;
  gl_Position = uProj * uView * vec4(a_pos, 1.0);
}
`;

  const fs = `
#ifdef GL_ES
precision mediump float;
#endif

varying vec3 v_nrm;
varying vec3 v_col;
varying vec3 v_pos;

uniform vec3 uLightDir;   // normalized, world-space direction TOWARDS light
uniform vec3 uLightColor; // directional intensity (rgb)
uniform vec3 uAmbient;    // env color * intensity

uniform int  uPLCount;
uniform vec3 uPLPos[${MAX_POINT_LIGHTS}];
uniform vec3 uPLCol[${MAX_POINT_LIGHTS}];

void main(){
  vec3 N = normalize(v_nrm);
  vec3 col = v_col * uAmbient;

  // One directional light (optional)
  float ndl = max(dot(N, -uLightDir), 0.0);
  col += v_col * uLightColor * ndl;

  // Point lights (hard, unshadowed)
  for (int i=0;i<${MAX_POINT_LIGHTS};++i){
    if (i>=uPLCount) break;
    vec3 Lvec = uPLPos[i] - v_pos;
    float d2 = max(dot(Lvec,Lvec), 1e-4);
    vec3  L  = Lvec * inversesqrt(d2);
    float ndlp = max(dot(N, L), 0.0);
    float atten = 1.0 / (1.0 + d2 * 0.05);
    col += v_col * uPLCol[i] * (ndlp * atten);
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

  return { vs, fs, MAX_POINT_LIGHTS };
}
