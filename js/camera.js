// js/camera.js
import { vec3, add, sub, scale } from './utils.js';

/**
 * FINAL CAMERA STATE AND CONTROLS
 */
export const camera = {
  pos: vec3(0, 0, 5),
  yaw: 0,
  pitch: 0,
  speed: 2.5,
  sensitivity: 1.5,
};

export const keysPressed = new Set();

/**
 * Updates the camera state based on key presses.
 * Arrow Keys: Look around.
 * WASD: Move "Minecraft-style" on the XZ plane, relative to camera yaw.
 * Space/Shift: Move up/down on the world Y axis.
 */
export function updateCamera(deltaTime) {
  const moveStep = camera.speed * deltaTime;
  const lookStep = camera.sensitivity * deltaTime;

  // Look with arrow keys
  if (keysPressed.has('arrowup'))    camera.pitch += lookStep;
  if (keysPressed.has('arrowdown'))  camera.pitch -= lookStep;
  if (keysPressed.has('arrowleft'))  camera.yaw   -= lookStep;
  if (keysPressed.has('arrowright')) camera.yaw   += lookStep;

  // Clamp pitch just shy of +/- 90° to avoid gimbal flip
  const lim = Math.PI * 0.5 - 0.1;
  camera.pitch = Math.max(-lim, Math.min(lim, camera.pitch));

  // Wrap yaw to [-π, π] to keep numbers small
  if (camera.yaw >  Math.PI) camera.yaw -= Math.PI * 2;
  if (camera.yaw < -Math.PI) camera.yaw += Math.PI * 2;

  // WASD on XZ plane
  const forward = vec3(Math.cos(camera.yaw), 0, Math.sin(camera.yaw));
  const right   = vec3(Math.sin(camera.yaw), 0, -Math.cos(camera.yaw));

  if (keysPressed.has('w')) camera.pos = add(camera.pos, scale(forward, moveStep));
  if (keysPressed.has('s')) camera.pos = sub(camera.pos, scale(forward, moveStep));
  if (keysPressed.has('a')) camera.pos = add(camera.pos, scale(right,   moveStep));
  if (keysPressed.has('d')) camera.pos = sub(camera.pos, scale(right,   moveStep));

  // Vertical movement
  if (keysPressed.has(' '))     camera.pos.y += moveStep;
  if (keysPressed.has('shift')) camera.pos.y -= moveStep;
}
