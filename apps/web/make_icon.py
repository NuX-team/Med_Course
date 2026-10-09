#!/usr/bin/env python3
"""Dark icon: warm black, an orange dot at 8 o'clock on a thin clock ring. Writes iOS + web sizes."""
import json, os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024
BG, ORANGE, RING = (13, 13, 11), (255, 106, 26), (58, 56, 51)

big = S * 4
im = Image.new('RGB', (big, big), BG)
d = ImageDraw.Draw(im)
c = big // 2
r = int(big * 0.30)
w = int(big * 0.022)
d.ellipse((c - r, c - r, c + r, c + r), outline=RING, width=w)
for i in range(12):
    import math
    a = math.radians(i * 30)
    r1, r2 = r * 0.80, r * 0.90
    d.line((c + r1 * math.sin(a), c - r1 * math.cos(a), c + r2 * math.sin(a), c - r2 * math.cos(a)), fill=RING, width=w)
# Hand pointing at 8 o'clock, dot on the ring at 8.
a = math.radians(240)
d.line((c, c, c + r * 0.62 * math.sin(a), c - r * 0.62 * math.cos(a)), fill=(237, 234, 227), width=int(w * 1.6))
dot = int(big * 0.085)
x, y = c + r * math.sin(a), c - r * math.cos(a)
d.ellipse((x - dot, y - dot, x + dot, y + dot), fill=ORANGE)
d.ellipse((c - w * 1.6, c - w * 1.6, c + w * 1.6, c + w * 1.6), fill=(237, 234, 227))
im = im.resize((S, S), Image.LANCZOS)

ios = os.path.join(ROOT, 'ios', 'MedCourse', 'Assets.xcassets', 'AppIcon.appiconset')
os.makedirs(ios, exist_ok=True)
im.save(os.path.join(ios, 'icon-1024.png'))
web = os.path.join(ROOT, 'web')
for size in (180, 192, 512):
    im.resize((size, size), Image.LANCZOS).save(os.path.join(web, f'icon-{size}.png'))
print('icons written')
