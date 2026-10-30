import os
import struct
from datetime import datetime, timezone

from PIL import Image

from photosorter import media, mover, planner


def jpeg(path, taken=None, color=(200, 80, 40), make="Apple"):
    im = Image.new("RGB", (64, 48), color)
    exif = Image.Exif()
    if make:
        exif[media.TAG_MAKE] = make
    if taken:
        exif.get_ifd(media.EXIF_IFD)[media.TAG_DATETIME_ORIGINAL] = taken
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, exif=exif)


def png(path, color=(10, 10, 10)):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.new("RGB", (40, 80), color).save(path)


def mov(path, when):
    """A tiny QuickTime file with just enough boxes to carry a creation date."""
    seconds = int((when - media.QUICKTIME_EPOCH).total_seconds())
    mvhd_body = b"\x00\x00\x00\x00" + struct.pack(">II", seconds, seconds) + b"\x00" * 88
    mvhd = struct.pack(">I4s", 8 + len(mvhd_body), b"mvhd") + mvhd_body
    moov = struct.pack(">I4s", 8 + len(mvhd), b"moov") + mvhd
    ftyp = struct.pack(">I4s", 16, b"ftyp") + b"qt  \x00\x00\x00\x00"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(ftyp + struct.pack(">I4s", 16, b"free") + b"\x00" * 8 + moov)


def library(root):
    jpeg(f"{root}/IMG_0001.jpg", "2023:07:14 10:00:00")
    jpeg(f"{root}/trip/IMG_0002.jpg", "2024:01:02 09:30:00", color=(1, 2, 3))
    jpeg(f"{root}/trip/copy of IMG_0002.jpg", "2024:01:02 09:30:00", color=(1, 2, 3))  # same bytes
    png(f"{root}/Screenshot 2024-03-05 at 11.12.13.png")
    png(f"{root}/IMG_0100.PNG", color=(50, 60, 70))  # PNG with no camera info: a phone screenshot
    jpeg(f"{root}/IMG_0003.HEIC.jpg", None, make=None)  # no date anywhere but the file date
    jpeg(f"{root}/live/IMG_0004.jpg", "2022:12:25 18:00:00", color=(9, 9, 9))
    mov(f"{root}/live/IMG_0004.mov", datetime(2022, 12, 25, 18, 0, tzinfo=timezone.utc))
    mov(f"{root}/clips/VID_20210601_120000.mp4", datetime(2021, 6, 1, 12, 0, tzinfo=timezone.utc))
    with open(f"{root}/notes.txt", "w") as f:
        f.write("not a photo")
    os.makedirs(f"{root}/.hidden", exist_ok=True)
    jpeg(f"{root}/.hidden/IMG_9.jpg", "2020:01:01 00:00:00")


def where(plan):
    return {os.path.relpath(m["src"], plan["source"]): os.path.relpath(m["dst"], plan["dest"]) for m in plan["moves"]}


def test_plan_puts_files_in_the_right_folders(tmp_path):
    library(tmp_path)
    plan = planner.build_plan(str(tmp_path))
    w = where(plan)
    j = os.path.join

    assert w["IMG_0001.jpg"] == j("Photos", "2023", "2023-07", "IMG_0001.jpg")
    assert w[j("trip", "IMG_0002.jpg")] == j("Photos", "2024", "2024-01", "IMG_0002.jpg")
    assert w[j("trip", "copy of IMG_0002.jpg")] == j("Duplicates", "copy of IMG_0002.jpg")
    assert w["Screenshot 2024-03-05 at 11.12.13.png"] == j("Screenshots", "2024", "Screenshot 2024-03-05 at 11.12.13.png")
    assert w["IMG_0100.PNG"].startswith("Screenshots" + os.sep)
    # Live Photo video stays with its photo, not in Videos.
    assert w[j("live", "IMG_0004.mov")] == j("Photos", "2022", "2022-12", "IMG_0004.mov")
    assert w[j("clips", "VID_20210601_120000.mp4")] == j("Videos", "2021", "2021-06", "VID_20210601_120000.mp4")
    # Non-media and hidden files are left alone.
    assert "notes.txt" not in w and not any(".hidden" in k for k in w)
    assert plan["skipped"] == 1

    summary = planner.summarize(plan)
    assert summary["total"] == 9
    assert summary["duplicates"] == 1
    assert summary["date_sources"]["file date"] >= 1


def test_same_name_in_two_folders_is_never_overwritten(tmp_path):
    jpeg(f"{tmp_path}/a/IMG_1.jpg", "2024:05:05 10:00:00", color=(1, 1, 1))
    jpeg(f"{tmp_path}/b/IMG_1.jpg", "2024:05:06 10:00:00", color=(2, 2, 2))
    plan = planner.build_plan(str(tmp_path))
    targets = sorted(os.path.basename(m["dst"]) for m in plan["moves"])
    assert targets == ["IMG_1 (1).jpg", "IMG_1.jpg"]


def test_sort_then_undo_restores_everything(tmp_path):
    library(tmp_path)
    before = sorted(
        os.path.relpath(os.path.join(r, f), tmp_path) for r, _, fs in os.walk(tmp_path) for f in fs)
    plan = planner.build_plan(str(tmp_path))
    result = mover.apply_plan(plan)
    assert result["done"] == 9 and not result["errors"]
    assert os.path.exists(tmp_path / "Sorted" / "Photos" / "2023" / "2023-07" / "IMG_0001.jpg")
    assert not os.path.exists(tmp_path / "IMG_0001.jpg")
    assert os.path.exists(result["names"])

    # A second scan ignores the Sorted folder itself.
    assert planner.build_plan(str(tmp_path))["moves"] == []

    runs = mover.list_runs(plan["dest"])
    assert len(runs) == 1 and not runs[0]["undone"]
    undo = mover.undo(runs[0]["log"])
    assert undo["done"] == 9 and not undo["errors"]
    after = sorted(
        os.path.relpath(os.path.join(r, f), tmp_path) for r, _, fs in os.walk(tmp_path)
        for f in fs if "Sorted" not in r)
    assert after == before
    # Empty folders the run made are gone; only the log and name list remain.
    assert sorted(os.listdir(tmp_path / "Sorted")) == [".photo-sorter", os.path.basename(result["names"])]
    assert mover.list_runs(plan["dest"])[0]["undone"]
    assert mover.undo(runs[0]["log"])["errors"]  # can't undo twice


def test_copy_mode_leaves_originals(tmp_path):
    library(tmp_path)
    plan = planner.build_plan(str(tmp_path))
    mover.apply_plan(plan, copy=True)
    assert os.path.exists(tmp_path / "IMG_0001.jpg")
    assert os.path.exists(tmp_path / "Sorted" / "Photos" / "2023" / "2023-07" / "IMG_0001.jpg")
    mover.undo(mover.list_runs(plan["dest"])[0]["log"])
    assert os.path.exists(tmp_path / "IMG_0001.jpg")
    assert not os.path.exists(tmp_path / "Sorted" / "Photos")


def test_by_content_uses_category_folders(tmp_path):
    jpeg(f"{tmp_path}/a.jpg", "2024:05:05 10:00:00")
    png(f"{tmp_path}/Screenshot 1.png")
    plan = planner.build_plan(str(tmp_path), classify=lambda paths, progress: {p: "Food & drinks" for p in paths})
    w = where(plan)
    assert w["a.jpg"] == os.path.join("Photos", "Food & drinks", "2024", "a.jpg")
    assert w["Screenshot 1.png"].startswith("Screenshots")  # screenshots aren't sent to the AI


def test_dates_from_file_names():
    assert media.date_from_name("IMG_20240714_101112.jpg") == datetime(2024, 7, 14)
    assert media.date_from_name("PXL_20231231_235959.mp4") == datetime(2023, 12, 31)
    assert media.date_from_name("Screenshot 2024-03-05 at 11.12.13.png") == datetime(2024, 3, 5)
    assert media.date_from_name("IMG_4821.JPG") is None
    assert media.date_from_name("20241399.jpg") is None
