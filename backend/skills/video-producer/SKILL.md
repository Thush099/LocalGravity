---
name: video-producer
description: Trim, concatenate, compress, caption, and export video with ffmpeg, including vertical crops, thumbnails, and loudness normalization.
triggers: ["video", "ffmpeg", "trim", "clip", "compress video", "subtitles", "caption", "thumbnail", "reel", "mp4"]
---

# Video Producer

Use this skill for any ffmpeg task: trimming, joining, compressing, resizing, captioning, or exporting social clips.

## Workflow

1. **Probe** the source: duration, resolution, frame rate, codecs, audio channels, rotation.
2. **Choose an output spec** for the destination (web, social, archive, presentation).
3. **Test a short segment** first, then render the full file.
4. **Verify** with `ffprobe` and `inspect_media` at several timestamps.

## Probe

```zsh
ffprobe -v error -print_format json -show_format -show_streams input.mov
```

## Trim without re-encoding (fast, keyframe-accurate)

```zsh
ffmpeg -y -ss 00:00:12.500 -i input.mov -t 00:00:18 -c copy clip.mov
```

For frame-accurate cuts, re-encode:

```zsh
ffmpeg -y -i input.mov -ss 12.5 -to 30.5 -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k clip.mp4
```

## Compress for sharing (1080p, broadly compatible)

```zsh
ffmpeg -y -i input.mov -vf "scale=-2:1080" -c:v libx264 -preset slow -crf 23 \
  -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 160k output.mp4
```

## Vertical 9:16 social clip with blurred background

```zsh
ffmpeg -y -i input.mp4 -filter_complex \
"[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28[bg]; \
 [0:v]scale=1080:-2[fg]; [bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]" \
 -map "[v]" -map 0:a? -c:v libx264 -crf 21 -preset medium -c:a aac -b:a 160k vertical.mp4
```

## Concatenate clips with the same codecs

```zsh
printf "file '%s'\n" "$PWD/a.mp4" "$PWD/b.mp4" > list.txt
ffmpeg -y -f concat -safe 0 -i list.txt -c copy joined.mp4
```

## Burn or attach subtitles

```zsh
ffmpeg -y -i input.mp4 -vf "subtitles=captions.srt:force_style='FontName=Arial,FontSize=22,Outline=1'" captioned.mp4
```

## Thumbnail and contact sheet

```zsh
ffmpeg -y -ss 00:00:03 -i input.mp4 -frames:v 1 -vf "scale=1280:-2" thumb.jpg
ffmpeg -y -i input.mp4 -vf "fps=1/10,scale=320:-2,tile=4x3" sheet.jpg
```

## Normalize loudness (two-pass EBU R128)

```zsh
ffmpeg -i input.mp4 -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -
# then pass measured values back into a second loudnorm pass
```

## Verify

```zsh
ffprobe -v error -show_entries format=duration,size:stream=width,height,r_frame_rate,codec_name -of default=nw=1 output.mp4
```

Call `inspect_media` on the output at the start, middle, and end to catch black frames, bad crops, or desync.

## Guardrails

- Keep the original file untouched; always write a new output path.
- Do not upscale SD footage to 4K and call it higher quality.
- Re-encode when cutting across keyframes or joining mismatched sources; explain the quality tradeoff.
- Check audio sync after trimming and after concatenation.
- Avoid `-c copy` when the destination player may not support the source codec.
- For long renders, report the expected time and run them without holding the chat open when possible.
