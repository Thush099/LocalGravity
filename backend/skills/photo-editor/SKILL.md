---
name: photo-editor
description: "Convert HEIC/RAW photos, batch resize/crop, adjust tone/exposure/sharpness, watermark images, inspect visuals, and automate Pixelmator Pro."
triggers: ["photo", "image", "png", "jpg", "jpeg", "heic", "resize", "crop", "watermark", "magick", "imagemagick", "pixelmator", "color"]
---

# Photo Editor Workflow (ImageMagick + sips + Vision Inspection)

## 1. Visual Inspection Loop
Always call `inspect_media(path)` before making aesthetic adjustments and again on the edited output file so you can confirm framing, exposure, contrast, and text legibility visually. Never overwrite the original file—write to a new filename or `edited/` subfolder.

## 2. Core Recipes
- **Fast macOS HEIC/PNG to JPEG (`sips`):**
  ```zsh
  sips -s format jpeg -s formatOptions 90 "photo.heic" --out "photo.jpg"
  ```
- **Resize preserving aspect ratio (`magick`):**
  ```zsh
  magick "input.jpg" -auto-orient -resize "1920x1920>" -quality 90 "resized.jpg"
  ```
- **Tone & clarity polish (subtle contrast, saturation, unsharp mask):**
  ```zsh
  magick "input.jpg" -auto-orient -modulate 102,110,100 -sigmoidal-contrast 3x50% -unsharp 0x0.8+0.8+0.02 "polished.jpg"
  ```
- **Batch export social square/portrait crops:**
  ```zsh
  magick "input.jpg" -gravity center -crop 4:5 +repage -resize 1080x1350^ "portrait_4x5.jpg"
  ```
- **Strip sensitive EXIF location metadata before sharing:**
  ```zsh
  magick "input.jpg" -auto-orient -strip "clean.jpg"
  ```

## 3. Pixelmator Pro Automation
When the user wants editable layer adjustments in **Pixelmator Pro**, write a small AppleScript (`osascript`) targeting `tell application "Pixelmator Pro"` to open documents and run color adjustments or export presets cleanly.
