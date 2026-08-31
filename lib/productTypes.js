// Classic script (no modules) so it shares scope with parser.js and the content
// script inside the content-script bundle. Exposes SpoonflowerProductTypes.

var SpoonflowerProductTypes = (function () {
  // Known raw SKU-style strings that leak through unrendered on some rows
  // (Spoonflower occasionally fails to translate an internal enum to its
  // display name). Extend this map as new variants show up.
  var SKU_MAP = {
    "WALLPAPER_PEEL_AND_STICK WALLPAPER_IMPERIAL_ROLL_2_x_6":
      "Peel and Stick Wallpaper Roll (Imperial, 2x6ft)"
  };

  function titleCaseFromSku(raw) {
    return raw
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  // Normalizes a raw product string (as it appears between "x" and "of design
  // id" in a Spoondollar sale line) into a clean display name.
  function normalizeProductName(raw) {
    if (!raw) return "Unknown";
    var trimmed = raw.trim();
    if (SKU_MAP[trimmed]) return SKU_MAP[trimmed];
    // Heuristic: an un-translated SKU is ALL_CAPS_WITH_UNDERSCORES
    if (/^[A-Z0-9_ ]+$/.test(trimmed) && trimmed.indexOf("_") !== -1) {
      return titleCaseFromSku(trimmed);
    }
    return trimmed;
  }

  // Coarse category used for grouping/charting. Best-effort heuristic based
  // on the product name and substrate text; Spoonflower doesn't expose a
  // clean category field in the ledger, so this is intentionally simple and
  // meant to be refined as more product-name variants are observed.
  function categorize(productName, substrate) {
    var haystack = ((productName || "") + " " + (substrate || "")).toLowerCase();
    if (haystack.indexOf("wallpaper") !== -1 || haystack.indexOf("peel and stick") !== -1 || haystack.indexOf("grasscloth") !== -1) {
      return "Wallpaper";
    }
    if (
      haystack.indexOf("fat quarter") !== -1 ||
      haystack.indexOf("fat eighth") !== -1 ||
      haystack.indexOf("swatch") !== -1 ||
      haystack.indexOf("yard") !== -1 ||
      haystack.indexOf("cotton") !== -1 ||
      haystack.indexOf("canvas") !== -1 ||
      haystack.indexOf("velvet") !== -1 ||
      haystack.indexOf("poplin") !== -1 ||
      haystack.indexOf("silk") !== -1 ||
      haystack.indexOf("minky") !== -1 ||
      haystack.indexOf("fleece") !== -1
    ) {
      return "Fabric";
    }
    return "Other";
  }

  return {
    normalizeProductName: normalizeProductName,
    categorize: categorize
  };
})();
