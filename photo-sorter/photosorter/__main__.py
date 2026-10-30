"""Start the app:  python -m photosorter

Or use it from the command line:
    python -m photosorter scan  "/path/to/photos"            show the plan
    python -m photosorter sort  "/path/to/photos" [--copy]   show the plan, then sort after you confirm
    python -m photosorter undo  "/path/to/photos/Sorted"     undo the last run
"""

import argparse
import os
import sys

from . import ai, mover, planner


def _progress(step, done, total):
    line = f"{step}... {done}/{total}" if total else f"{step}..."
    print("\r" + line.ljust(60), end="", flush=True)


def _print_summary(s):
    print("\r" + " " * 60 + "\r", end="")
    print(f"From: {s['source']}\nTo:   {s['dest']}\n")
    print(f"{s['total']} files ({s['total_size'] / 1e9:.2f} GB), {s['skipped']} other files left alone\n")
    for folder, n in s["folders"]:
        print(f"  {n:6d}  {folder}")
    guessed = s["date_sources"].get("file date", 0)
    if guessed:
        print(f"\n{guessed} files had no date inside them, so their file date was used.")


def main(argv=None):
    p = argparse.ArgumentParser(prog="photosorter", description="Sort photos and videos into folders.")
    sub = p.add_subparsers(dest="cmd")
    for name in ("scan", "sort"):
        c = sub.add_parser(name)
        c.add_argument("source")
        c.add_argument("--dest", help="where the sorted folders go (default: a 'Sorted' folder inside source)")
        c.add_argument("--copy", action="store_true", help="copy instead of move")
        c.add_argument("--by-content", action="store_true", help="sort photos by what is in them (AI add-on)")
        c.add_argument("--yes", action="store_true", help="don't ask before sorting")
    u = sub.add_parser("undo")
    u.add_argument("dest", help="the 'Sorted' folder")
    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--no-browser", action="store_true")
    args = p.parse_args(argv)

    if args.cmd in (None, "serve"):
        from .server import serve
        serve(port=getattr(args, "port", 8765), open_browser=not getattr(args, "no_browser", False))
        return

    if args.cmd == "undo":
        runs = [r for r in mover.list_runs(args.dest) if not r["undone"]]
        if not runs:
            sys.exit("Nothing to undo there.")
        result = mover.undo(runs[0]["log"], progress=_progress)
        print(f"\rPut back {result['done']} files.".ljust(60))
        for e in result["errors"]:
            print("  ! " + e)
        return

    if not os.path.isdir(args.source):
        sys.exit(f"No such folder: {args.source}")
    classify = None
    if args.by_content:
        if not ai.available():
            sys.exit("Sorting by content needs the AI add-on: pip install -r requirements-ai.txt")
        classify = ai.make_classifier()
    plan = planner.build_plan(args.source, args.dest, classify=classify, progress=_progress)
    _print_summary(planner.summarize(plan))
    if args.cmd == "scan" or not plan["moves"]:
        return
    if not args.yes and input(f"\n{'Copy' if args.copy else 'Move'} these files now? [y/N] ").lower() != "y":
        print("Nothing was changed.")
        return
    result = mover.apply_plan(plan, copy=args.copy, progress=_progress)
    print(f"\rSorted {result['done']} files. Original names are listed in {result['names']}".ljust(60))
    for e in result["errors"]:
        print("  ! " + e)


if __name__ == "__main__":
    main()
