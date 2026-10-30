"""Optional: sort photos by what is in them, using a free AI model that runs on
this computer (OpenCLIP). Nothing is uploaded anywhere.

Needs the extra packages in requirements-ai.txt. The first run downloads the
model once (about 600 MB).
"""

import re

DEFAULT_CATEGORIES = [
    "People",
    "Pets & animals",
    "Food & drinks",
    "Nature & landscapes",
    "Beach & sea",
    "City & buildings",
    "Documents & receipts",
    "Cars & vehicles",
    "Parties & events",
]

MODEL = "ViT-B-32"
WEIGHTS = "laion2b_s34b_b79k"
# Below this confidence a photo goes into "Other" instead of a weak guess.
MIN_CONFIDENCE = 0.35

# Extra wording per default category, so the model understands it better.
PROMPTS = {
    "People": ["a photo of people", "a selfie", "a portrait of a person", "a group photo of friends"],
    "Pets & animals": ["a photo of a pet", "a photo of a dog", "a photo of a cat", "a photo of a wild animal"],
    "Food & drinks": ["a photo of food", "a photo of a meal on a plate", "a photo of drinks"],
    "Nature & landscapes": ["a landscape photo", "a photo of mountains", "a photo of a forest", "a photo of flowers"],
    "Beach & sea": ["a photo of a beach", "a photo of the sea", "a photo of a swimming pool"],
    "City & buildings": ["a photo of a city street", "a photo of buildings", "a photo of a room interior"],
    "Documents & receipts": ["a photo of a document", "a photo of a receipt", "a photo of handwritten notes"],
    "Cars & vehicles": ["a photo of a car", "a photo of a motorbike", "a photo of a plane"],
    "Parties & events": ["a photo of a party", "a photo of a wedding", "a photo of a concert", "a birthday cake"],
}


def available():
    try:
        import open_clip  # noqa: F401
        import torch  # noqa: F401
    except ImportError:
        return False
    return True


def make_classifier(categories=None):
    """Return a function(paths, progress) -> {path: category name}."""
    # Category names become folder names, so drop characters folders can't have.
    categories = [re.sub(r'[\\/:*?"<>|]', "-", c).strip(" .") for c in (categories or DEFAULT_CATEGORIES)]
    categories = [c for c in categories if c]

    def classify(paths, progress=None):
        import open_clip
        import torch
        from PIL import Image

        report = progress or (lambda *a: None)
        report("Loading the AI model (first time downloads it)", 0, 0)
        device = "cuda" if torch.cuda.is_available() else (
            "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu")
        model, _, preprocess = open_clip.create_model_and_transforms(MODEL, pretrained=WEIGHTS)
        model = model.to(device).eval()
        tokenizer = open_clip.get_tokenizer(MODEL)

        with torch.no_grad():
            label_vectors = []
            for c in categories:
                prompts = PROMPTS.get(c, [f"a photo of {c.lower()}", f"a picture of {c.lower()}"])
                v = model.encode_text(tokenizer(prompts).to(device))
                v = v / v.norm(dim=-1, keepdim=True)
                v = v.mean(dim=0)
                label_vectors.append(v / v.norm())
            labels = torch.stack(label_vectors)

            result, batch_size = {}, 16
            for start in range(0, len(paths), batch_size):
                report("Looking at photos", start, len(paths))
                batch, ok = [], []
                for p in paths[start:start + batch_size]:
                    try:
                        with Image.open(p) as im:
                            batch.append(preprocess(im.convert("RGB")))
                        ok.append(p)
                    except Exception:
                        result[p] = "Other"  # e.g. RAW files Pillow can't open
                if not batch:
                    continue
                img = model.encode_image(torch.stack(batch).to(device))
                img = img / img.norm(dim=-1, keepdim=True)
                probs = (100.0 * img @ labels.T).softmax(dim=-1)
                conf, idx = probs.max(dim=-1)
                for p, c, i in zip(ok, conf.tolist(), idx.tolist()):
                    result[p] = categories[i] if c >= MIN_CONFIDENCE else "Other"
        return result

    return classify
