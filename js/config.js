/**
 * Global configuration settings for the ASCII Ray Tracer.
 */
let SCREEN_SCALE = 5;
let FONT_HEIGHT_WIDTH_RATIO = 1.5;

export const config = {
  TARGET_FPS: 60,

  DEFAULT_BACKEND: 'pathtrace', // or 'raster' | 'raytrace' | 'pt' | 'r' | 'rt'

  USE_GRAYSCALE: false, // true for grayscale text, false for color

  ASCII_RAMP: " .:-=+*#%@",
  ASCII_RAMP: "@%#*+=-:. ",
  //ASCII_RAMP: "@&#+=~-;:\",.",
  //ASCII_RAMP: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  //ASCII_RAMP: "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ",

  // Virtual grid (scrollable world)
  VIRTUAL_GRID_WIDTH: 16 * SCREEN_SCALE * FONT_HEIGHT_WIDTH_RATIO,
  VIRTUAL_GRID_HEIGHT: 9 * SCREEN_SCALE,

  // ---- ASCII modal smoothing (majority filter) ----
  // Turn on/off neighbor-majority smoothing of glyphs
  ASCII_MODE_FILTER: true,   // set false to disable

  // Odd kernel size in cells (3, 5, 7, ...)
  ASCII_MODE_KERNEL: 5,

  // Minimum number of neighbor votes (excluding center) needed
  // to replace the center glyph with the neighborhood’s modal glyph.
  // For K=3 there are 8 neighbors; 5 is a good default.
  ASCII_MODE_THRESH: 5*5 * 0.5,

  EPSILON: 0.000001,
  RIPPLE_SPEED: 0.05,
  MAX_RIPPLE_RADIUS: 100,
  PI_DIGITS:
    "31415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679",

  CAMERA: {
    FOVY_DEG: 80,
  },

  // ---- Path tracer core params ----
  PATH_TRACER: {
    SAMPLES_PER_BATCH: 32,
    MAX_BOUNCES: 5,
    LIGHT_COLOR: [16.86, 10.76, 8.2], // stable default "area light" color
    GAMMA_EXP: 1.0,                   // *** no gamma correction ***
    // PIXEL_ASPECT is filled at runtime from measured char size
  },

  // ---- Adaptive sampling (per-pixel) ----
  ADAPTIVE: {
    ENABLED: true,
    MAX_TOLERANCE: 0.10,
    MAX_SAMPLES: 64, // reasonable cap
    RESET_ON_CAMERA_CHANGE: true,
  },
};