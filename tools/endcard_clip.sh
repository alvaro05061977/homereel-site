#!/usr/bin/env bash
# Turn an end-card PNG into a 5-second h264 clip that video_concatenate can
# append to the film. Matches the master: 24 fps, yuv420p. A SILENT stereo AAC
# track is included on purpose - concatenating a video-only segment after clips
# that carry foley makes some muxers drop or desync the audio.
#   usage: endcard_clip.sh in.png out.mp4 [seconds]
set -euo pipefail
IN="$1"; OUT="$2"; DUR="${3:-5}"
ffmpeg -y -loglevel error \
  -loop 1 -framerate 24 -t "$DUR" -i "$IN" \
  -f lavfi -t "$DUR" -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -vf "fade=t=in:st=0:d=0.6,format=yuv420p" \
  -c:v libx264 -preset medium -crf 18 -r 24 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 128k -shortest "$OUT"
echo "$OUT"
