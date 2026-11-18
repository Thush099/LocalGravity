---
name: image-batch-processor
description: Batch resize, convert, compress, watermark, and organize photos on macOS with sips and ImageMagick while preserving originals.
triggers: ["image", "images", "photo", "photos", "resize", "compress", "convert", "heic", "watermark", "thumbnail", "batch"]
---

# Image Batch Processor

Use this skill for resizing, converting, compressing, watermarking, or organizing image folders.

## Workflow

1. **Inspect the set first**: formats, dimensions, color profiles, and count.
2. **Work on copies** in a new output directory. Never overwrite originals unless explicitly asked.
3. **Test on 2-3 representative files**, verify with `inspect_media`, then run the batch.
4. **Report** input count, output count, total size before/after, and any failures.

## Inventory

```zsh
find ~/Pictures/input -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.heic' -o -iname '*.webp' \) | wc -l
sips -g pixelWidth -g pixelHeight -g format ~/Pictures/input/sample.heic
```

## sips recipes (built in)

Resize the long edge to 1600 px and convert to JPEG:

```zsh
mkdir -p ~/Pictures/output
for f in ~/Pictures/input/*.{png,jpg,jpeg,heic}; do
  [ -e "$f" ] || continue
  sips -s format jpeg -s formatOptions 82 -Z 1600 "$f" --out "$HOME/Pictures/output/$(basename "${f%.*}").jpg"
done
```

Create 400 px thumbnails:

```zsh
sips -Z 400 ~/Pictures/input/*.jpg --out ~/Pictures/thumbs
```

Read metadata without modifying:

```zsh
sips -g all ~/Pictures/input/photo.jpg
```

## ImageMagick recipes

```zsh
magick mogrify -path ~/Pictures/output -resize '1600x1600>' -strip -quality 82 ~/Pictures/input/*.jpg
magick montage ~/Pictures/output/*.jpg -tile 4x -geometry 240x240+6+6 ~/Pictures/contact-sheet.jpg
magick ~/Pictures/input/photo.jpg -gravity southeast -pointsize 28 -fill white -undercolor '#00000080' -annotate +24+24 '© Studio' ~/Pictures/output/photo.jpg
```

## HEIC and WebP

- Convert HEIC to JPEG: `sips -s format jpeg input.heic --out output.jpg`.
- Keep HEIC for Apple Photos, use JPEG for sharing, WebP for web when the destination supports it.
- Preserve EXIF orientation; check a portrait photo after conversion.
- Strip GPS/location metadata before publishing with `-strip` (ImageMagick) or `exiftool -gps:all= -overwrite_original`.

## Naming and organization

Use sortable, lowercase names: `YYYY-MM-DD_client_project_###.jpg`. Put derivatives next to a `_originals` folder or in `output/`, never mixed with sources.

## Verification

```zsh
du -sh ~/Pictures/input ~/Pictures/output
magick identify -format '%f %wx%h %b\n' ~/Pictures/output/sample.jpg
```

Then call `inspect_media` on one output to check framing, color, and text legibility.

## Guardrails

- Never run `rm` on the input folder; move rejects to a `_rejected` folder instead.
- Do not upscale beyond the source resolution unless asked; report the limit.
- Keep aspect ratio unless the user requests an exact crop, and state the crop.
- Do not add watermarks the user did not request.
- Check disk space before writing thousands of derivatives.
