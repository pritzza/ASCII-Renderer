// js/config.js

/**
 * Global configuration settings for the ASCII Ray Tracer.
 */
let SCREEN_SCALE = 5;
let FONT_HEIGHT_WIDTH_RATIO = 1;
export const config = {
    TARGET_FPS: 60,
    
    USE_GRAYSCALE: false, // Set to true for grayscale, false for color

    //ASCII_RAMP: " .:-=+*#%@",
    //ASCII_RAMP: "@%#*+=-:. ",
    ASCII_RAMP: " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
    //ASCII_RAMP: "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ",
   
    // Defines the total size of the virtual, scrollable world
    VIRTUAL_GRID_WIDTH: 16 * SCREEN_SCALE * FONT_HEIGHT_WIDTH_RATIO,
    VIRTUAL_GRID_HEIGHT: 9 * SCREEN_SCALE,

    // A factor to divide the number of color bands by.
    // 1 = full palette, 2 = half, 3 = third, etc. Must be >= 1.
    COLOR_REDUCTION_FACTOR: 1,
   
    EPSILON: 0.000001,
    MAX_BOUNCES: 4, // The maximum number of times a ray can reflect.
    RIPPLE_SPEED: 0.05,
    MAX_RIPPLE_RADIUS: 100,
    PI_DIGITS: "31415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679",
};