"""Regenerate the frontend's offline visitor map with Python's standard library.

Natural Earth v5.1.2 public-domain 1:50m map units and 1:10m label points.
License: https://www.naturalearthdata.com/about/terms-of-use/
The Equal Earth projection follows Šavrič, Patterson & Jenny, doi:10.1080/13658816.2018.1504949.
"""
import hashlib
import json
import math
import sys
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/"
FILES = (
    ("ne_50m_admin_0_map_units", "b8d421aca6e9e08e8cdf09cc26af111cc3e0deba4fe915611d58ade71e8a4db0"),
    ("ne_10m_admin_0_label_points", "2f26ad9dd03c543d1aec3cd593c288367fd27a0ccd68db8a31182a95ad361196"),
)


def features(index):
    name, digest = FILES[index]
    if len(sys.argv) == 3:
        data = Path(sys.argv[index + 1]).read_bytes()
    else:
        with urlopen(SOURCE + name + ".geojson", timeout=60) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f"Unrecognised source file: {name}")
    return json.loads(data)["features"]


@lru_cache(maxsize=None)
def project(lon, lat):
    theta = math.asin(math.sqrt(3) * math.sin(math.radians(lat)) / 2)
    a, b, c, d = 1.340264, -0.081106, 0.000893, 0.003796
    y = a * theta + b * theta**3 + c * theta**7 + d * theta**9
    derivative = a + 3 * b * theta**2 + 7 * c * theta**6 + 9 * d * theta**8
    x = 2 * math.radians(lon) * math.cos(theta) / (math.sqrt(3) * derivative)
    return 480 + x * 175, 240 - y * 175


def simplify(points):
    """Keep the endpoints and all points deviating by over half a map pixel."""
    ax, ay = points[0]
    bx, by = points[-1]
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    greatest, pivot = 0.55**2, None
    for index, (x, y) in enumerate(points[1:-1], 1):
        ratio = min(1, max(0, ((x - ax) * dx + (y - ay) * dy) / length)) if length else 0
        distance = (x - ax - ratio * dx)**2 + (y - ay - ratio * dy)**2
        if distance > greatest:
            greatest, pivot = distance, index
    if pivot is None:
        return [points[0], points[-1]]
    return simplify(points[:pivot + 1])[:-1] + simplify(points[pivot:])


def svg_ring(ring, junctions):
    starts = [i for i, point in enumerate(ring) if point in junctions] or [0]
    out = []
    for i, start in enumerate(starts):
        end = starts[(i + 1) % len(starts)]
        arc = ring[start:end + 1] if start < end else ring[start:] + ring[:end + 1]
        # A border shared by two shapes takes the same path in both directions.
        reverse = arc[0] > arc[-1]
        reduced = simplify(arc[::-1] if reverse else arc)
        out.extend((reduced[::-1] if reverse else reduced)[:-1])
    rounded = [(round(x), round(y)) for x, y in out]
    points = [p for i, p in enumerate(rounded) if p != rounded[i - 1]]
    if len(set(points)) < 3:
        return ""
    return "M" + " ".join(f"{x},{y}" for x, y in points) + "Z"


def main():
    rings, labels = defaultdict(list), {}
    neighbours = defaultdict(set)
    for feature in features(0):
        p, g = feature["properties"], feature["geometry"]
        code = p["ISO_A2_EH"]
        if code == "-99":
            code = ""  # Retain unattributed land as a neutral geographic outline.
        if code:
            score = (p["ISO_A2"] == code, p["POP_EST"])
            if code not in labels or score > labels[code][0]:
                labels[code] = (score, project(p["LABEL_X"], p["LABEL_Y"]))
        polygons = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for polygon in polygons:
            for raw in polygon:
                ring = [project(*xy) for xy in raw[:-1]]
                rings[code].append(ring)
                for i, point in enumerate(ring):
                    neighbours[point].add(ring[i - 1])
                    neighbours[ring[i - 1]].add(point)
    # These three ISO territories are too small for the 50m map-unit dataset.
    small = {"BVT": "BV", "GIB": "GI", "MQI": "UM"}  # Midway represents the US outlying islands.
    for feature in sorted(features(1), key=lambda f: f["properties"]["scalerank"]):
        code = small.get(feature["properties"]["sr_gu_a3"])
        if code and code not in labels:
            labels[code] = (None, project(*feature["geometry"]["coordinates"]))
    junctions = {p for p, adjacent in neighbours.items() if len(adjacent) != 2}
    areas = {}
    for code, parts in sorted(rings.items()):
        path = "".join(svg_ring(ring, junctions) for ring in parts)
        if path:
            areas[code] = path
    points = {code: [round(x), round(y)] for code, (_, (x, y)) in sorted(labels.items())}
    if len(points) != 250:  # 249 ISO territories plus the commonly reported XK.
        raise ValueError(f"Unexpected country coverage: {len(points)}")
    target = ROOT / "web-admin/src/lib/visitor-world.json"
    with target.open("w", encoding="utf-8") as out:
        json.dump({"areas": areas, "points": points}, out, sort_keys=True, separators=(",", ":"))
        out.write("\n")


if __name__ == "__main__":
    main()
