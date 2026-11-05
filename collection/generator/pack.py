#!/usr/bin/env python3
"""Packs the generator's output into the archives the server ships with.
Usage: python3 pack.py OUT_DIR COLLECTION_DIR   (OUT_DIR from citizens.py: images/, thumbs/)
Writes COLLECTION_DIR/citizens-images.tar.gz and citizens-thumbs.tar.gz: plain ustar, "<n>.png" at the top level,
which is all server/src/assets.js accepts."""
import os, sys, tarfile

out, dest = sys.argv[1], sys.argv[2]
for sub, name in (("images", "citizens-images.tar.gz"), ("thumbs", "citizens-thumbs.tar.gz")):
    src = os.path.join(out, sub)
    files = sorted(os.listdir(src), key=lambda f: int(f.split(".")[0]))
    with tarfile.open(os.path.join(dest, name), "w:gz", format=tarfile.USTAR_FORMAT) as t:
        for f in files:
            ti = t.gettarinfo(os.path.join(src, f), arcname=f)
            ti.uid = ti.gid = 0; ti.uname = ti.gname = ""; ti.mtime = 0
            with open(os.path.join(src, f), "rb") as fh:
                t.addfile(ti, fh)
    print(f"{name}: {len(files)} files")
