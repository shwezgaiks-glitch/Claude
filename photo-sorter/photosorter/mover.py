"""Carry out a plan, write a log of every move, and undo a run from its log."""

import csv
import json
import os
import shutil
from datetime import datetime

from .planner import STATE_DIR


def runs_dir(dest):
    return os.path.join(dest, STATE_DIR, "runs")


def _free_name(path):
    base, ext = os.path.splitext(path)
    candidate, n = path, 1
    while os.path.exists(candidate):
        candidate = f"{base} ({n}){ext}"
        n += 1
    return candidate


def apply_plan(plan, copy=False, progress=None):
    """Move (or copy) every file in the plan. Returns the path of the run's log.

    The log is written one line per file as it goes, so even an interrupted run
    can be undone.
    """
    report = progress or (lambda *a: None)
    dest = plan["dest"]
    os.makedirs(runs_dir(dest), exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    log_path = os.path.join(runs_dir(dest), f"{stamp}.jsonl")
    names_path = os.path.join(dest, f"original-names_{stamp}.csv")

    moves = plan["moves"]
    done, errors = 0, []
    with open(log_path, "w", encoding="utf-8") as log, \
            open(names_path, "w", newline="", encoding="utf-8-sig") as names:
        log.write(json.dumps({"run": stamp, "source": plan["source"], "dest": dest,
                              "action": "copy" if copy else "move"}) + "\n")
        writer = csv.writer(names)
        writer.writerow(["original location", "new location"])
        for i, m in enumerate(moves):
            if i % 10 == 0:
                report("Copying" if copy else "Moving", i, len(moves))
            src = m["src"]
            if not os.path.exists(src):
                errors.append(f"{src}: no longer there")
                continue
            dst = _free_name(m["dst"])  # never overwrite, even if something appeared since the scan
            try:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if copy:
                    shutil.copy2(src, dst)
                else:
                    shutil.move(src, dst)
            except OSError as e:
                errors.append(f"{src}: {e}")
                continue
            log.write(json.dumps({"src": src, "dst": dst}) + "\n")
            log.flush()
            writer.writerow([src, dst])
            done += 1
    report("Done", len(moves), len(moves))
    return {"log": log_path, "names": names_path, "done": done, "errors": errors}


def read_log(log_path):
    with open(log_path, encoding="utf-8") as f:
        lines = [json.loads(line) for line in f if line.strip()]
    header, entries = lines[0], [l for l in lines[1:] if "src" in l]
    header["undone"] = any(l.get("undone") for l in lines[1:])
    return header, entries


def list_runs(dest):
    folder = runs_dir(dest)
    if not os.path.isdir(folder):
        return []
    runs = []
    for name in sorted(os.listdir(folder), reverse=True):
        if name.endswith(".jsonl"):
            path = os.path.join(folder, name)
            try:
                header, entries = read_log(path)
            except (OSError, ValueError, IndexError):
                continue
            runs.append({"log": path, "run": header["run"], "action": header["action"],
                         "files": len(entries), "undone": header["undone"]})
    return runs


def undo(log_path, progress=None):
    """Put every file from a run back where it was."""
    report = progress or (lambda *a: None)
    header, entries = read_log(log_path)
    if header["undone"]:
        return {"done": 0, "errors": ["This run was already undone."]}
    copied = header["action"] == "copy"
    done, errors, touched_dirs = 0, [], set()
    for i, e in enumerate(reversed(entries)):
        if i % 10 == 0:
            report("Undoing", i, len(entries))
        src, dst = e["src"], e["dst"]
        if not os.path.exists(dst):
            errors.append(f"{dst}: not found, skipped")
            continue
        try:
            if copied:
                os.remove(dst)  # only the copy this app made; the original was never touched
            else:
                if os.path.exists(src):
                    errors.append(f"{src}: something else is there now, left {dst} in place")
                    continue
                os.makedirs(os.path.dirname(src), exist_ok=True)
                shutil.move(dst, src)
        except OSError as err:
            errors.append(f"{dst}: {err}")
            continue
        touched_dirs.add(os.path.dirname(dst))
        done += 1

    # Remove folders the run created that are now empty.
    dest = os.path.realpath(header["dest"])
    for d in sorted(touched_dirs, key=len, reverse=True):
        while os.path.realpath(d).startswith(dest + os.sep):
            try:
                os.rmdir(d)
            except OSError:
                break
            d = os.path.dirname(d)

    with open(log_path, "a", encoding="utf-8") as f:
        f.write(json.dumps({"undone": datetime.now().isoformat(timespec="seconds")}) + "\n")
    report("Done", len(entries), len(entries))
    return {"done": done, "errors": errors}
