"""Measure lossless compression on real accepted R60 update payloads."""
import argparse
import csv
import hashlib
import json
import random
import time
from pathlib import Path
from statistics import median

import lz4.frame
import zstandard


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--count", type=int, default=30)
    args = parser.parse_args()
    if not 1 <= args.count <= 150:
        parser.error("count must be 1–150")
    rounds = json.loads((args.archive / "research" / "rounds.json").read_bytes())
    accepted = [(r["idx"], u["payload_sha"]) for r in rounds if r["state"] == "COMMITTED" for u in r["accepted"]]
    compressor, decompressor = zstandard.ZstdCompressor(level=3), zstandard.ZstdDecompressor()
    methods = [("none", lambda x:x, lambda x:x), ("lz4", lz4.frame.compress, lz4.frame.decompress),
               ("zstd-3", compressor.compress, decompressor.decompress)]
    rng = random.Random(303)
    rows = []
    for index, h in rng.sample(accepted, args.count):
        blob = (args.archive / "cas" / h).read_bytes()
        if hashlib.sha256(blob).hexdigest() != h:
            raise ValueError("R60 payload differs from its checksum")
        methods_copy = methods[:]
        rng.shuffle(methods_copy)
        for name, compress, uncompress in methods_copy:
            t = time.perf_counter_ns()
            packed = compress(blob)
            mid = time.perf_counter_ns()
            unpacked = uncompress(packed)
            end = time.perf_counter_ns()
            if unpacked != blob:
                raise ValueError("Codec is not lossless")
            row = {"class": "MEASURED", "round": index + 1, "sha256": h, "codec": name, "source_bytes": len(blob),
                   "compressed_bytes": len(packed), "encode_ms": (mid-t)/1e6, "decode_ms": (end-mid)/1e6}
            for bps in (10, 50, 100):
                row[f"estimated_serial_ms_{bps}mbps"] = row["encode_ms"]+row["decode_ms"]+8000*len(packed)/(bps*1e6)
            rows.append(row)
    with args.out.with_suffix(".jsonl").open("x", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row) + "\n")
    with args.out.with_suffix(".csv").open("x", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    for codec, _, _ in methods:
        data = [r for r in rows if r["codec"] == codec]
        print(codec, "median ratio", round(median(r["compressed_bytes"]/r["source_bytes"] for r in data), 4),
              "encode_ms", round(median(r["encode_ms"] for r in data), 2),
              "decode_ms", round(median(r["decode_ms"] for r in data), 2))


if __name__ == "__main__":
    main()
