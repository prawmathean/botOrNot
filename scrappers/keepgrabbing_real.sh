#!/bin/bash

LIMIT="${1:-100}"
SIZE="${2:-300x300}"
OUT_DIR="${3:-images/picsum}"

WIDTH="${SIZE%x*}"
HEIGHT="${SIZE#*x}"

mkdir -p "$OUT_DIR"

# resume support: count what's already there instead of starting over
existing=$(find "$OUT_DIR" -name "*.jpg" | wc -l)
count=$existing

echo "Target: $LIMIT images | Size: ${WIDTH}x${HEIGHT} | Output: $OUT_DIR"
echo "Already have: $existing"

while [ "$count" -lt "$LIMIT" ]; do
    id=$((RANDOM * RANDOM))  # cheap unique-ish filename seed
    file_path="$OUT_DIR/picsum_${id}.jpg"

    # -s silent, -f fail on HTTP errors, -L follow redirects (picsum redirects to actual image)
    if curl -s -f -L "https://picsum.photos/${WIDTH}/${HEIGHT}" -o "$file_path"; then
        count=$((count + 1))
        printf "\rDownloaded: %d / %d" "$count" "$LIMIT"
    else
        echo -e "\nRequest failed, retrying..."
        rm -f "$file_path"
        sleep 1
    fi

    sleep 0.2  # be reasonable, even though picsum has no strict rate limit
done

echo -e "\nDone. $count images in $OUT_DIR"
