// src/core/color.ts
// Shared color parsing helpers. SpriteForge stores colors as `#RRGGBB`
// or `#RRGGBBAA` strings everywhere (project background, bone palette,
// slot tint). Both the WebGL skin renderer and the canvas viewport need
// to convert those strings to floats — this module is the one place
// that hex math lives.

/** Parse a `#RRGGBB` or `#RRGGBBAA` string into a 4-channel float tuple
 *  in [0, 1]. Tolerant of missing hash, missing alpha, and bad input —
 *  on any failure we fall back to opaque white so renderers can call
 *  this without guarding every input. */
export function parseHexRGBA(hex?: string): [number, number, number, number] {
  if (!hex) return [1, 1, 1, 1];
  const s = hex.startsWith("#") ? hex.slice(1) : hex;
  if (s.length !== 6 && s.length !== 8) return [1, 1, 1, 1];
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) : 255;
  if (Number.isNaN(r + g + b + a)) return [1, 1, 1, 1];
  return [r / 255, g / 255, b / 255, a / 255];
}

/** Parse a `#RRGGBB` (no alpha) into a 3-channel float tuple. Falls
 *  back to dark gray on bad input — used for the stage clear color
 *  where a wrong fallback is more visible than a silent zero. */
export function parseHexRGB(hex: string): [number, number, number] {
  const [r, g, b] = parseHexRGBA(hex);
  return [r, g, b];
}
