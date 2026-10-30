"""Work out what a file is and when it was taken."""

import os
import re
import shutil
import struct
import subprocess
import json
from datetime import datetime, timedelta, timezone

from PIL import Image

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # HEIC dates then come from the file name or file date
    pass

PHOTO_EXT = {
    ".jpg", ".jpeg", ".png", ".heic", ".heif", ".gif", ".webp", ".tif", ".tiff", ".bmp",
    # Camera RAW files
    ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2", ".srw", ".pef",
}
VIDEO_EXT = {
    ".mov", ".mp4", ".m4v", ".avi", ".mkv", ".3gp", ".mts", ".m2ts", ".wmv", ".webm", ".mpg", ".mpeg",
}

SCREENSHOT_NAME = re.compile(
    r"screen[ _-]?shot|screen[ _-]?record|screen[ _-]?capture|bildschirmfoto|capture d.?[ée]cran|scrnli",
    re.IGNORECASE,
)
# 20240714, 2024-07-14, 2024_07_14 ... anywhere in the name
NAME_DATE = re.compile(r"(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)")

EXIF_IFD = 0x8769
TAG_DATETIME_ORIGINAL = 36867
TAG_DATETIME_DIGITIZED = 36868
TAG_DATETIME = 306
TAG_MAKE = 271

QUICKTIME_EPOCH = datetime(1904, 1, 1, tzinfo=timezone.utc)


def kind_of(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in PHOTO_EXT:
        return "photo"
    if ext in VIDEO_EXT:
        return "video"
    return None


def _parse_exif_date(value):
    if not value:
        return None
    value = str(value).strip().replace("\x00", "")
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y:%m:%d"):
        try:
            dt = datetime.strptime(value[:19] if "%H" in fmt else value[:10], fmt)
        except ValueError:
            continue
        if dt.year >= 1980:  # cameras with a reset clock write 0000 or 1970
            return dt
    return None


def read_photo(path):
    """Return (date or None, camera make or None, image format or None)."""
    try:
        with Image.open(path) as im:
            exif = im.getexif()
            fmt = im.format
    except Exception:
        return None, None, None
    sub = exif.get_ifd(EXIF_IFD) if exif else {}
    date = (
        _parse_exif_date(sub.get(TAG_DATETIME_ORIGINAL))
        or _parse_exif_date(sub.get(TAG_DATETIME_DIGITIZED))
        or _parse_exif_date(exif.get(TAG_DATETIME))
    )
    make = (str(exif.get(TAG_MAKE)).strip("\x00 ") or None) if exif.get(TAG_MAKE) else None
    return date, make, fmt


def _quicktime_date(path):
    """Read the creation time from the 'mvhd' box of a .mov/.mp4 file, without ffmpeg."""
    try:
        with open(path, "rb") as f:
            size_total = os.fstat(f.fileno()).st_size
            end = size_total
            pos = 0
            # Walk top-level boxes to 'moov', then its children to 'mvhd'.
            for wanted in (b"moov", b"mvhd"):
                found = False
                while pos + 8 <= end:
                    f.seek(pos)
                    header = f.read(8)
                    if len(header) < 8:
                        return None
                    size, box = struct.unpack(">I4s", header)
                    head_len = 8
                    if size == 1:
                        size = struct.unpack(">Q", f.read(8))[0]
                        head_len = 16
                    elif size == 0:
                        size = end - pos
                    if size < head_len:
                        return None
                    if box == wanted:
                        found = True
                        break
                    pos += size
                if not found:
                    return None
                if wanted == b"moov":
                    end = pos + size
                    pos += head_len
            f.seek(pos + head_len)
            version = f.read(1)[0]
            f.read(3)
            if version == 1:
                seconds = struct.unpack(">Q", f.read(8))[0]
            else:
                seconds = struct.unpack(">I", f.read(4))[0]
    except (OSError, struct.error, IndexError):
        return None
    if seconds == 0:
        return None
    dt = (QUICKTIME_EPOCH + timedelta(seconds=seconds)).astimezone().replace(tzinfo=None)
    return dt if 1980 <= dt.year <= datetime.now().year + 1 else None


def _ffprobe_date(path):
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", path],
            capture_output=True, text=True, timeout=20,
        ).stdout
        tags = json.loads(out or "{}").get("format", {}).get("tags", {})
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    for key in ("com.apple.quicktime.creationdate", "creation_time"):
        value = tags.get(key)
        if value:
            try:
                dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                continue
            if dt.tzinfo:
                dt = dt.astimezone().replace(tzinfo=None)
            if dt.year >= 1980:
                return dt
    return None


def read_video_date(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".mov", ".mp4", ".m4v", ".3gp"):
        dt = _quicktime_date(path)
        if dt:
            return dt
    return _ffprobe_date(path)


def date_from_name(name):
    m = NAME_DATE.search(name)
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def inspect(path):
    """Everything the planner needs to know about one media file."""
    name = os.path.basename(path)
    kind = kind_of(path)
    stat = os.stat(path)
    info = {"kind": kind, "size": stat.st_size, "screenshot": False, "date": None, "date_source": None}

    if kind == "photo":
        date, make, fmt = read_photo(path)
        info["date"], info["date_source"] = (date, "photo info") if date else (None, None)
        # Phone screenshots are PNGs with no camera details in them.
        info["screenshot"] = bool(SCREENSHOT_NAME.search(name)) or (fmt == "PNG" and not make and not date)
    elif kind == "video":
        date = read_video_date(path)
        info["date"], info["date_source"] = (date, "video info") if date else (None, None)
        info["screenshot"] = bool(SCREENSHOT_NAME.search(name))

    if not info["date"]:
        date = date_from_name(name)
        if date:
            info["date"], info["date_source"] = date, "file name"
    if not info["date"]:
        # Last resort: when the file was last changed. Often the copy date, so
        # it is flagged in the preview.
        info["date"] = datetime.fromtimestamp(stat.st_mtime)
        info["date_source"] = "file date"
    return info
