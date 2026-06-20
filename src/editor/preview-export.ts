// src/editor/preview-export.ts
// MP4 preview export (FR-EX-5).
//
// Design:
//   - Capture frames from the editor's WebGL preview canvas while
//     stepping the active animation timeline.
//   - MP4: lazy-load `@ffmpeg/ffmpeg`; write captured frames as PNGs
//     into ffmpeg.wasm's virtual filesystem and encode H.264 MP4.
//
// The imports are dynamic so editor.js's normal startup path does not
// eagerly evaluate the encoders. Esbuild will bundle split only if the
// build config enables splitting; otherwise the code is still isolated
// behind user action.

import type { Project } from "../core/model";
import type { Viewport } from "./viewport";
import { bus, EV } from "./bus";
import { getActiveAnimation, setCurrentTime } from "./store";
import type { EditorState } from "./store";
import { downloadBlob, slugifyName } from "./save-load";

export interface PreviewExportOptions {
  fps?: number;
  seconds?: number;
  width?: number;
  height?: number;
}

function safeName(project: Project, ext: string): string {
  return `${slugifyName(project.name, "spriteforge")}-preview.${ext}`;
}

const download = downloadBlob;

/** Capture `frameCount` RGBA frames from the viewport's WebGL canvas by
 *  stepping the editor playhead. We snapshot and restore the current
 *  playhead after capture so exporting doesn't disturb the user's edit
 *  position. */
async function captureFrames(
  state: EditorState,
  viewport: Viewport,
  opts: Required<PreviewExportOptions>,
): Promise<Array<{ data: ImageData; timestampUs: number }>> {
  const anim = getActiveAnimation(state);
  const duration = Math.min(opts.seconds, anim?.duration ?? opts.seconds);
  const frameCount = Math.max(1, Math.ceil(duration * opts.fps));
  const savedTime = state.playback.currentTime;
  const wasPlaying = state.playback.playing;
  state.playback.playing = false;
  const canvas = document.createElement("canvas");
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not create 2D capture canvas");
  const frames: Array<{ data: ImageData; timestampUs: number }> = [];

  try {
    for (let i = 0; i < frameCount; i++) {
      const t = (i / opts.fps) % Math.max(0.001, anim?.duration ?? duration);
      setCurrentTime(state, t);
      bus.emit(EV.PROJECT_CHANGED);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      ctx.fillStyle = state.project.background || "#2a2f3a";
      ctx.fillRect(0, 0, opts.width, opts.height);
      const srcW = viewport.gl.width;
      const srcH = viewport.gl.height;
      const scale = Math.min(opts.width / srcW, opts.height / srcH);
      const dw = srcW * scale;
      const dh = srcH * scale;
      const dx = (opts.width - dw) / 2;
      const dy = (opts.height - dh) / 2;
      ctx.drawImage(viewport.gl, 0, 0, srcW, srcH, dx, dy, dw, dh);
      frames.push({ data: ctx.getImageData(0, 0, opts.width, opts.height), timestampUs: Math.round((i / opts.fps) * 1_000_000) });
    }
  } finally {
    setCurrentTime(state, savedTime);
    state.playback.playing = wasPlaying;
    bus.emit(EV.PROJECT_CHANGED);
  }
  return frames;
}

function resolveOptions(state: EditorState, opts: PreviewExportOptions): Required<PreviewExportOptions> {
  const anim = getActiveAnimation(state);
  return {
    fps: opts.fps ?? state.project.fps ?? 30,
    seconds: opts.seconds ?? Math.max(0.5, Math.min(5, anim?.duration ?? 1)),
    width: opts.width ?? state.project.width,
    height: opts.height ?? state.project.height,
  };
}

async function imageDataToPngBytes(imageData: ImageData): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create PNG conversion canvas");
  ctx.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Could not encode frame PNG")), "image/png");
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function exportMp4Preview(
  state: EditorState,
  viewport: Viewport,
  opts: PreviewExportOptions = {},
): Promise<{ filename: string; bytes: number; frames: number }> {
  const o = resolveOptions(state, opts);
  const frames = await captureFrames(state, viewport, o);
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const ffmpeg = new FFmpeg();
  const logs: string[] = [];
  ffmpeg.on("log", ({ type, message }) => {
    logs.push(`[${type}] ${message}`);
    if (logs.length > 40) logs.shift();
  });
  await ffmpeg.load({
    classWorkerURL: "/public/vendor/ffmpeg/worker.js",
    coreURL: "/public/vendor/ffmpeg/ffmpeg-core.js",
    wasmURL: "/public/vendor/ffmpeg/ffmpeg-core.wasm",
  });

  const inputPattern = "frame_%05d.png";
  const outputName = "preview.mp4";
  for (let i = 0; i < frames.length; i++) {
    await ffmpeg.writeFile(`frame_${String(i + 1).padStart(5, "0")}.png`, await imageDataToPngBytes(frames[i]!.data));
  }
  const result = await ffmpeg.exec([
    "-framerate", String(o.fps),
    "-start_number", "1",
    "-i", inputPattern,
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-movflags", "faststart",
    outputName,
  ]);
  if (result !== 0) {
    const detail = logs.length ? `\n\nffmpeg log:\n${logs.join("\n")}` : "";
    throw new Error(`ffmpeg.wasm failed to encode MP4 (exit ${result}).${detail}`);
  }
  const data = await ffmpeg.readFile(outputName);
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  for (let i = 0; i < frames.length; i++) {
    try { await ffmpeg.deleteFile(`frame_${String(i + 1).padStart(5, "0")}.png`); } catch {}
  }
  try { await ffmpeg.deleteFile(outputName); } catch {}
  ffmpeg.terminate();
  const filename = safeName(state.project, "mp4");
  download(new Blob([new Uint8Array(bytes)], { type: "video/mp4" }), filename);
  return { filename, bytes: bytes.byteLength, frames: frames.length };
}
