---
name: video-editor
description: "Trim, stitch, reframe (16:9 to 9:16), compress, mix audio, extract frames for vision inspection, and build FCPXML timelines for Final Cut Pro."
triggers: ["video", "ffmpeg", "clip", "reel", "mp4", "mov", "trim", "cut", "compress", "fcpxml", "final cut", "subtitles", "audio"]
---

# Video Editor Workflow (macOS M4 + ffmpeg + Final Cut Pro)

## 1. Always Probe & Inspect First
1. Run `ffprobe` via `run_command`:
   ```zsh
   ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,duration -of default=noprint_wrappers=1 "input.mp4"
   ```
2. Call `inspect_media` on the video path (with `timestamp_sec` or omitted for a 2x2 contact sheet) so you actually see framing, colors, lighting, and text placement before editing.

## 2. Fast Recipes (macOS Hardware & Stream-Copy)
- **Lossless fast trim (no re-encode):**
  ```zsh
  ffmpeg -y -ss 00:00:05 -to 00:00:20 -i "input.mp4" -c copy "trimmed.mp4"
  ```
- **High-efficiency macOS VideoToolbox compress (great for WhatsApp/web):**
  ```zsh
  ffmpeg -y -i "input.mp4" -c:v h264_videotoolbox -b:v 4M -c:a aac -b:a 160k -movflags +faststart "compressed.mp4"
  ```
- **Reframe 16:9 to 9:16 Vertical Reel (center crop):**
  ```zsh
  ffmpeg -y -i "input.mp4" -vf "crop=ih*9/16:ih,scale=1080:1920" -c:v h264_videotoolbox -b:v 8M -c:a copy "reel_9x16.mp4"
  ```
- **Normalize loudness (`loudnorm`) & extract audio:**
  ```zsh
  ffmpeg -y -i "input.mp4" -af "loudnorm=I=-14:TP=-1.5:LRA=11" -c:v copy "normalized.mp4"
  ```

## 3. Final Cut Pro Bridge (`FCPXML`)
When asked to prep rough cuts for **Final Cut Pro**, generate a clean `.fcpxml` (v1.10) referencing exact local `file://` clip paths and frame durations verified from `ffprobe`, then verify output after exporting with `inspect_media`.
