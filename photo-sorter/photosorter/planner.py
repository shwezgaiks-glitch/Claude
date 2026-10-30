"""Build a sorting plan: where every file would go. Nothing is moved here."""

import hashlib
import os
from collections import Counter, defaultdict

from . import media

STATE_DIR = ".photo-sorter"  # logs live here, inside the destination folder
SKIP_NAMES = {"thumbs.db", "desktop.ini", ".ds_store"}


def default_dest(source):
    return os.path.join(source, "Sorted")


def _walk(source, dest):
    """Yield media files under source, skipping hidden files and the destination."""
    dest_real = os.path.realpath(dest)
    for root, dirs, files in os.walk(source):
        dirs[:] = sorted(
            d for d in dirs
            if not d.startswith(".") and os.path.realpath(os.path.join(root, d)) != dest_real
        )
        for name in sorted(files):
            if name.startswith(".") or name.lower() in SKIP_NAMES:
                continue
            yield os.path.join(root, name)


def _hash(path, limit=None):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        remaining = limit
        while True:
            chunk = f.read(1 << 20 if remaining is None else min(1 << 20, remaining))
            if not chunk:
                break
            h.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
                if remaining <= 0:
                    break
    return h.hexdigest()


def find_duplicates(items, progress=None):
    """Return {path of a duplicate: path of the copy that is kept}."""
    by_size = defaultdict(list)
    for item in items:
        if item["size"] > 0:
            by_size[item["size"]].append(item)
    groups = [g for g in by_size.values() if len(g) > 1]

    rank = {"photo info": 0, "video info": 0, "file name": 1, "file date": 2}
    dupes = {}
    for i, group in enumerate(groups):
        if progress:
            progress(i, len(groups))
        # Cheap pass on the first 1 MB, then a full hash only where that matches.
        by_head = defaultdict(list)
        for item in group:
            by_head[_hash(item["src"], 1 << 20)].append(item)
        for same_head in by_head.values():
            if len(same_head) < 2:
                continue
            if same_head[0]["size"] <= (1 << 20):  # the first 1 MB was the whole file
                matches = [same_head]
            else:
                by_full = defaultdict(list)
                for item in same_head:
                    by_full[_hash(item["src"])].append(item)
                matches = by_full.values()
            for same in matches:
                if len(same) < 2:
                    continue
                same.sort(key=lambda it: (rank.get(it["date_source"], 3), len(it["src"]), it["src"]))
                for dup in same[1:]:
                    dupes[dup["src"]] = same[0]["src"]
    return dupes


def _folder_for(item, categories):
    date = item["date"]
    year = f"{date:%Y}"
    month = f"{date:%Y-%m}"
    if item["screenshot"]:
        return os.path.join("Screenshots", year)
    if item["kind"] == "video":
        return os.path.join("Videos", year, month)
    category = categories.get(item["src"])
    if category:
        return os.path.join("Photos", category, year)
    return os.path.join("Photos", year, month)


def _unique(path, taken):
    """Add ' (1)', ' (2)' ... so no file is ever overwritten."""
    base, ext = os.path.splitext(path)
    candidate, n = path, 1
    while candidate.lower() in taken or os.path.exists(candidate):
        candidate = f"{base} ({n}){ext}"
        n += 1
    taken.add(candidate.lower())
    return candidate


def build_plan(source, dest=None, classify=None, progress=None):
    """Scan source and decide a destination for every photo and video.

    classify: optional function(list of photo paths, progress) -> {path: category},
    used when sorting photos by what is in them.
    """
    source = os.path.abspath(source)
    dest = os.path.abspath(dest or default_dest(source))
    report = progress or (lambda *a: None)

    report("Finding files", 0, 0)
    paths = list(_walk(source, dest))
    items, skipped = [], 0
    for i, path in enumerate(paths):
        if i % 25 == 0:
            report("Reading dates", i, len(paths))
        if not media.kind_of(path):
            skipped += 1
            continue
        try:
            info = media.inspect(path)
        except OSError:
            skipped += 1
            continue
        info["src"] = path
        items.append(info)

    dupes = find_duplicates(items, lambda i, n: report("Looking for duplicates", i, n))

    # Live Photos: the short video next to a photo with the same name goes with it.
    photos_by_stem = {}
    for item in items:
        if item["kind"] == "photo" and item["src"] not in dupes:
            photos_by_stem[os.path.splitext(item["src"])[0].lower()] = item
    companions = {}
    for item in items:
        if item["kind"] == "video" and item["src"] not in dupes:
            photo = photos_by_stem.get(os.path.splitext(item["src"])[0].lower())
            if photo:
                companions[item["src"]] = photo

    categories = {}
    if classify:
        photo_paths = [
            it["src"] for it in items
            if it["kind"] == "photo" and not it["screenshot"] and it["src"] not in dupes
        ]
        categories = classify(photo_paths, lambda i, n: report("Looking at photos", i, n))

    by_src = {it["src"]: it for it in items}
    taken, moves = set(), []
    report("Planning", 0, 0)
    for item in items:
        src = item["src"]
        name = os.path.basename(src)
        if src in dupes:
            folder, reason = "Duplicates", "duplicate of " + os.path.relpath(dupes[src], source)
        elif src in companions:
            photo = companions[src]
            folder, reason = _folder_for(photo, categories), "Live Photo video, kept with its photo"
            item = dict(item, date=photo["date"])
        else:
            folder, reason = _folder_for(item, categories), None
        target = _unique(os.path.join(dest, folder, name), taken)
        moves.append({
            "src": src,
            "dst": target,
            "folder": folder,
            "kind": "screenshot" if by_src[src]["screenshot"] else item["kind"],
            "size": item["size"],
            "date": item["date"].strftime("%Y-%m-%d %H:%M"),
            "date_source": item["date_source"],
            "category": categories.get(src),
            "note": reason,
        })

    return {"source": source, "dest": dest, "moves": moves, "skipped": skipped}


def summarize(plan, sample=200):
    """A small, JSON-friendly overview for the preview screen."""
    moves = plan["moves"]
    folders = Counter(m["folder"] for m in moves)
    top = Counter(m["folder"].split(os.sep)[0] for m in moves)
    return {
        "source": plan["source"],
        "dest": plan["dest"],
        "total": len(moves),
        "total_size": sum(m["size"] for m in moves),
        "skipped": plan["skipped"],
        "top": dict(top.most_common()),
        "folders": sorted(([f.replace(os.sep, "/"), n] for f, n in folders.items())),
        "date_sources": dict(Counter(m["date_source"] for m in moves)),
        "duplicates": top.get("Duplicates", 0),
        "sample": [
            {
                "from": os.path.relpath(m["src"], plan["source"]),
                "to": os.path.relpath(m["dst"], plan["dest"]),
                "date": m["date"],
                "date_source": m["date_source"],
                "note": m["note"],
            }
            for m in moves[:sample]
        ],
    }
